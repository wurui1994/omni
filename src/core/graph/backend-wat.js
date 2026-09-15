// src/core/graph/backend-wat.js —— **第四个后端：wasm（WAT 文本）**
//
// `docs/design/node-graph-contract.md` §9 那段"先量后写"的下一步。这一份的价值不在
// "多一条腿"，在**让缺口清单第一次真的有内容**：前三个后端（interp / sx / js）都住在
// JS 宿主里，什么都接得住，于是 `gaps()` 一直是空转的。wasm 不一样 —— 它没有字符串、
// 没有 GC、控制流是结构化的，接不住的东西当场说出名字。
//
// ## 判据（这一份不许自说自话）
//
// 出来的 WAT 文本交给**另一个前端**（`src/core/frontend-wat/lower.js`，WAT -> OIR）读，
// 再用 `interpretMir` 真跑一遍，输出与 interp / js 两条腿逐行相同。
// 也就是说：这一格的正确性由一条**互不相干的**已有实现来证，不是由我自己证。
//
// ## 能接的子集（量出来的，见设计文档 §9 那三条）
//
//   整数（i64）· 函数 + 调用 + return · if（语句位置与**值位置**都行）· while（含 post 步进）
//   · 打印整数 · **记录与列表**（线性内存 + 一格 bump 分配器）
//
// ## 布局（没有类型的那一层怎么排内存）
//
//   * 一块 `(memory 1)` + 一格 `(global $hp (mut i32))`，从 8 号地址起（0 留空）。
//   * 值一律 8 字节（i64）。地址也装在 i64 里，取内存时 `i32.wrap_i64` ——
//     那一格转换就是"wasm 有线性内存但没有原生指针"的样子。
//   * **字段名 -> 槽位是一张管整个模块的表**：图这一层没有类型，`field-get` 只拿到名字，
//     所以 `x` 在任何记录里都落同一格偏移，记录按"它用到的最大槽位"分配。
//     浪费空间但不会错 —— 真正按类型排的布局要等 `carry` 那一问有类型（附录 A.5）。
//   * 列表：**长度存在偏移 0，元素从 8 起**。`index-get` 的边界检查因此有地方读
//     （越界落 `unreachable` —— 那是 `index-get` 与 `field-get` 分两格的理由之一）。
//
// ## 接不住的，有名有姓
//
//   * 字符串 —— 宿主面只有 `print_i64` 这一族（打印字符串要先有 `print_str` 那格导入）。
//   * `loop-exit`（break / continue）—— **墙在 OIR**：`br` 跳外层 block 报
//     "OIR has no labeled break"。这一条是量出来的，不是猜的。
//   * 闭包（`func` 当值用 / 嵌套 `func`）· 多值（`values` / `pick`）· `scope-exit`。

import { NODES } from './nodes.js';
// 判据那一侧：出来的文本交给**另一个前端**读、用 MIR 的解释器真跑
// （所以这一格的正确性不由我自己证 —— 见文件头"判据"那一段）。
import { lowerWat } from '../frontend-wat/lower.js';
import { Diagnostics, SourceFile } from '../source/diag.js';
import { interpretMir } from '../mir/interp.js';

/** 能接住的节点：**白名单**（不在名单里的一律给一句人话，那句话就是账）。 */
const CAN = new Map([
  ['const', true], ['ref', true], ['bind', true], ['set', true],
  ['call', true], ['prim', true], ['branch', true], ['loop', true],
  ['region', true], ['func', true], ['ret', true],
  // 记录与列表在线性内存里（一格 bump 分配器 + 一张字段偏移表，见文件头"布局"那一段）
  ['record-new', true], ['field-get', true], ['field-set', true],
  ['list-new', true], ['index-get', true], ['index-set', true],
  ['values', 'wasm 没有多值出端口的表示（要先定 carry 那一问的答案）'],
  ['pick', 'wasm 没有多值出端口的表示'],
  ['conv', 'wasm 这一批只有 i64：`float` 那一格要 f64 与"两种数值类型"的算术'],
  ['scope-exit', 'wasm 没有 unwind：出口动作要先把 region 的出口显式化'],
  ['loop-exit', 'OIR 还没有带标签的 break（br 跳外层 block 当场报）—— 墙在 OIR 不在 wasm'],
]);

export function watCan(op) {
  const ans = CAN.get(op);
  if (ans === undefined) return NODES.has(op) ? `wat 后端还没接：${op}` : `no such node: ${op}`;
  return ans;
}

/** 一格算符 -> wasm 指令。比较那一族出 i32（只许在条件位置用），别的出 i64。 */
const ARITH = new Map([
  ['+', 'i64.add'], ['-', 'i64.sub'], ['*', 'i64.mul'],
  ['/', 'i64.div_s'], ['%', 'i64.rem_s'],
]);
const CMP = new Map([
  ['<', 'i64.lt_s'], ['>', 'i64.gt_s'], ['<=', 'i64.le_s'], ['>=', 'i64.ge_s'],
  ['=', 'i64.eq'], ['!=', 'i64.ne'],
]);

/** wasm 的名字：`$` + 安全化（`max2` / `string-append` 那种带横杠的名字要转）。 */
const wname = (n) => `$${String(n).replace(/[^A-Za-z0-9_]/g, '_')}`;

class Gap extends Error {}

/** 缺口那句话：白名单里写好的理由优先（`can` 与 `lower` 说的是同一句）。 */
const why = (op, where) => {
  const ans = CAN.get(op);
  return new Gap(typeof ans === 'string' ? ans : `${where}上还接不住 ${op}`);
};

/** 一格函数的作用域：名字 -> wasm 局部量名。嵌套 region 里同名的量各占一格。 */
class Scope {
  constructor(fn, parent = null) { this.fn = fn; this.parent = parent; this.names = new Map(); }

  declare(name) {
    let id = wname(name);
    while (this.fn.taken.has(id)) id = `${id}_`;
    this.fn.taken.add(id);
    this.fn.locals.push(id);
    this.names.set(name, id);
    return id;
  }

  lookup(name) {
    for (let s = this; s !== null; s = s.parent) if (s.names.has(name)) return s.names.get(name);
    return null;
  }
}

const asList = (x) => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]));

/**
 * 一份 WAT 模块。`funcs` 是"顶层 bind 了一格 func"的那些，别的顶层语句进 `$__entry`。
 * 每个函数自己带一份 `locals`（wasm 的局部量是函数级的，所以 region 只影响名字查找）。
 */
class Mod {
  constructor() { this.fns = new Map(); this.out = []; }

  /** 建一格函数：`taken` 防重名、`locals` 收局部量、`ret` 记它到底出不出值。 */
  fn(name, params) {
    const f = { name, params, locals: [], taken: new Set(params.map(wname)), body: [], ret: false };
    this.fns.set(name, f);
    return f;
  }
}

/** 顶层 bind 的那些函数名（`call` 要认得它们 —— 别的名字当局部量）。 */
function topFuncs(items) {
  const names = new Map();
  for (const it of items) {
    if (it !== null && it !== undefined && it.op === 'bind' && it.ins?.init?.op === 'func') {
      names.set(it.attrs.name, wname(`f_${it.attrs.name}`));
    }
  }
  return names;
}

/**
 * 出一份 WAT。**跑两遍**：第一遍只为把"哪个函数出值"数出来（语句位置的调用要不要
 * `drop` 取决于它），第二遍拿着那张表出正式的文本。图都很小，两遍比猜便宜。
 */
function emitOnce(graph, retOf) {
  const items = asList(graph.kind === 'graph' ? graph.body : graph);
  const mod = new Mod();
  const fns = topFuncs(items);
  let loopSeq = 0;
  let tmpSeq = 0;
  let needMem = false;
  /**
   * **字段名 -> 槽位**（一张表管整个模块）。图这一层没有类型，`field-get` 只拿到名字，
   * 所以 `x` 在任何记录里都落同一格偏移；记录按"它用到的最大槽位"分配。
   * 浪费空间但不会错 —— 真正按类型排的布局要等 `carry` 那一问有类型（附录 A.5）。
   */
  const slots = new Map();
  const slotOf = (name) => {
    if (!slots.has(name)) slots.set(name, slots.size);
    return slots.get(name);
  };
  /** 地址：值一律 i64，取内存要 i32 —— 这一格转换就是"wasm 有内存没有指针"的样子。 */
  const addr = (e) => `(i32.wrap_i64 ${e})`;

  /** 一格 bump 分配：`$hp` 往前推 n 字节，返回装着地址的那格临时量。 */
  function alloc(bytes, sc, pre) {
    needMem = true;
    const a = tmp(sc);
    pre.push(`(local.set ${a} (i64.extend_i32_u (global.get $hp)))`);
    pre.push(`(global.set $hp (i32.add (global.get $hp) (i32.const ${bytes})))`);
    return a;
  }

  /** 下标的边界检查（`index-get` 与 `field-get` 分两格的理由之一，就是这一句）。 */
  function guard(o, i, pre) {
    pre.push(`(if (i64.lt_s (local.get ${i}) (i64.const 0)) (then (unreachable)))`);
    pre.push(`(if (i64.ge_s (local.get ${i}) (i64.load ${addr(`(local.get ${o})`)}))`
      + ' (then (unreachable)))');
  }

  const isTrue = (x) => x !== null && x !== undefined
    && ((x.lit === true) || (x.op === 'const' && x.attrs.value === true));

  /** 一格临时量。**值位置的 `if` 要它** —— wasm 的 block 不带 result（见文件头那条账）。 */
  function tmp(sc) {
    const id = `$t${++tmpSeq}`;
    sc.fn.taken.add(id);
    sc.fn.locals.push(id);
    return id;
  }

  /** 条件位置：出 i32。比较那一族直接出，别的与 0 比。 */
  function cond(x, sc, pre) {
    if (isTrue(x)) return '(i32.const 1)';
    if (x !== null && x !== undefined && x.op === 'prim' && CMP.has(x.attrs.name)) {
      const [a, b] = asList(x.ins.args);
      return `(${CMP.get(x.attrs.name)} ${expr(a, sc, pre)} ${expr(b, sc, pre)})`;
    }
    return `(i64.ne ${expr(x, sc, pre)} (i64.const 0))`;
  }

  /**
   * 值位置：出 i64。**只有整数**（字符串 / 记录 / 列表在 `can` 那儿就挡住了）。
   * 要先跑的语句推到 `pre` 里 —— 值位置的 `if` 就是靠这一格落地的。
   */
  function expr(x, sc, pre) {
    if (x === null || x === undefined) return '(i64.const 0)';
    if (Array.isArray(x)) return valueOf(x, sc, pre);
    if (x.lit !== undefined) return litOf(x.lit);
    switch (x.op) {
      case 'const': return litOf(x.attrs.value);
      case 'ref': {
        const id = sc.lookup(x.attrs.name);
        if (id === null) {
          if (fns.has(x.attrs.name)) throw new Gap('函数当值用（闭包）还没接');
          throw new Gap(`没绑过的名字：${x.attrs.name}`);
        }
        return `(local.get ${id})`;
      }
      case 'prim': {
        const args = asList(x.ins.args);
        const op = ARITH.get(x.attrs.name);
        if (op !== undefined) return `(${op} ${expr(args[0], sc, pre)} ${expr(args[1], sc, pre)})`;
        if (CMP.has(x.attrs.name)) {
          // 比较出 i32，要当值用得补一格符号扩展
          return `(i64.extend_i32_s ${cond(x, sc, pre)})`;
        }
        throw new Gap(`这格内建还没接：${x.attrs.name}`);
      }
      case 'call': return callOf(x, sc, pre);
      // **值位置的 `if`**：一格临时量 + 两支各赋值。wasm 的 block 不带 result，
      // 所以"表达式位置的 if"不是接不住，是要**先物化成一格临时量** ——
      // 而临时量本来就是调度器算出来的四样之一（ADR-0033 §3.5）。
      case 'branch': {
        const t = tmp(sc);
        const c = cond(x.ins.cond, sc, pre);
        const a = []; const av = valueOf(x.ins.then, new Scope(sc.fn, sc), a);
        const b = []; const bv = valueOf(x.ins.else, new Scope(sc.fn, sc), b);
        pre.push(`(if ${c} (then ${[...a, `(local.set ${t} ${av})`].join(' ')})`
          + ` (else ${[...b, `(local.set ${t} ${bv})`].join(' ')}))`);
        return `(local.get ${t})`;
      }
      // `region` 出值：前面几条当语句，最后一格是值（CL 的 `(let (…) … acc)`）
      case 'region': return valueOf(x.ins.body, new Scope(sc.fn, sc), pre);
      // ---- 记录与列表：**线性内存 + 一格 bump 分配器**（wasm 有内存没有指针）----
      case 'record-new': {
        const names = x.attrs.names ?? [];
        const vals = asList(x.ins.fields);
        const size = 8 * (names.length === 0 ? 1 : 1 + Math.max(...names.map(slotOf)));
        const a = alloc(size, sc, pre);
        names.forEach((k, i) => {
          const v = expr(vals[i], sc, pre);
          pre.push(`(i64.store (i32.add ${addr(`(local.get ${a})`)} (i32.const ${8 * slotOf(k)})) ${v})`);
        });
        return `(local.get ${a})`;
      }
      case 'field-get': {
        needMem = true;
        const o = expr(x.ins.obj, sc, pre);
        return `(i64.load (i32.add ${addr(o)} (i32.const ${8 * slotOf(x.attrs.field)})))`;
      }
      // 列表：**长度存在偏移 0，元素从 8 起** —— 边界检查因此有地方读
      case 'list-new': {
        const items = asList(x.ins.items);
        const a = alloc(8 * (items.length + 1), sc, pre);
        pre.push(`(i64.store ${addr(`(local.get ${a})`)} (i64.const ${items.length}))`);
        items.forEach((y, i) => {
          const v = expr(y, sc, pre);
          pre.push(`(i64.store (i32.add ${addr(`(local.get ${a})`)} (i32.const ${8 * (i + 1)})) ${v})`);
        });
        return `(local.get ${a})`;
      }
      case 'index-get': {
        needMem = true;
        const o = tmp(sc); pre.push(`(local.set ${o} ${expr(x.ins.obj, sc, pre)})`);
        const i = tmp(sc); pre.push(`(local.set ${i} ${expr(x.ins.index, sc, pre)})`);
        guard(o, i, pre);
        return `(i64.load (i32.add ${addr(`(local.get ${o})`)}`
          + ` (i32.add (i32.const 8) ${addr(`(i64.mul (local.get ${i}) (i64.const 8))`)})))`;
      }
      default: throw why(x.op, '值位置');
    }
  }

  /**
   * 一串东西的**值**：前面几条当语句，最后一格出值。
   * "最后一格有值出端口就是值"这条规矩与 js 后端的 `jsFnBody` **同一条** ——
   * 判据是出端口那一栏，不是 sort（那条被矩阵抓出来过两次）。
   */
  function valueOf(x, sc, pre) {
    const list = asList(x);
    if (list.length === 0) return '(i64.const 0)';
    for (const y of list.slice(0, -1)) pre.push(...stmt(y, sc, sc.fn));
    return expr(list[list.length - 1], sc, pre);
  }

  function litOf(v) {
    if (typeof v === 'number' && Number.isInteger(v)) return `(i64.const ${v})`;
    if (v === true) return '(i64.const 1)';
    if (v === false || v === null || v === undefined) return '(i64.const 0)';
    if (typeof v === 'string') throw new Gap('字符串要线性内存里的布局');
    throw new Gap(`这格字面量还没接：${JSON.stringify(v)}`);
  }

  function callOf(x, sc, pre) {
    const fn = x.ins.fn;
    const name = fn !== null && fn !== undefined && fn.op === 'ref' ? fn.attrs.name : null;
    if (name === null || !fns.has(name)) throw new Gap('间接调用（函数当值）还没接');
    const args = asList(x.ins.args).map((a) => expr(a, sc, pre));
    return `(call ${fns.get(name)}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
  }

  function stmts(xs, sc, f) { return asList(xs).flatMap((y) => stmt(y, sc, f)); }

  function stmt(x, sc, f) {
    if (x === null || x === undefined) return [];
    if (Array.isArray(x)) return stmts(x, sc, f);
    if (x.lit !== undefined) return [];
    const pre = [];
    switch (x.op) {
      case 'bind': {
        if (x.ins.init?.op === 'func') throw new Gap('嵌套的函数（闭包）还没接');
        const v = expr(x.ins.init, sc, pre);
        const id = sc.declare(x.attrs.name);      // 先算右值再声明：`local x = x` 才对
        return [...pre, `(local.set ${id} ${v})`];
      }
      case 'set': {
        const id = sc.lookup(x.attrs.name);
        if (id === null) throw new Gap(`赋值到没绑过的名字：${x.attrs.name}`);
        const v = expr(x.ins.value, sc, pre);
        return [...pre, `(local.set ${id} ${v})`];
      }
      case 'region': return stmts(x.ins.body, new Scope(f, sc), f);
      case 'field-set': {
        needMem = true;
        const o = expr(x.ins.obj, sc, pre);
        const v = expr(x.ins.value, sc, pre);
        return [...pre, `(i64.store (i32.add ${addr(o)} (i32.const ${8 * slotOf(x.attrs.field)})) ${v})`];
      }
      case 'index-set': {
        needMem = true;
        const o = tmp(sc); pre.push(`(local.set ${o} ${expr(x.ins.obj, sc, pre)})`);
        const i = tmp(sc); pre.push(`(local.set ${i} ${expr(x.ins.index, sc, pre)})`);
        guard(o, i, pre);
        const v = expr(x.ins.value, sc, pre);
        return [...pre, `(i64.store (i32.add ${addr(`(local.get ${o})`)}`
          + ` (i32.add (i32.const 8) ${addr(`(i64.mul (local.get ${i}) (i64.const 8))`)})) ${v})`];
      }
      case 'branch': {
        const c = cond(x.ins.cond, sc, pre);
        const t = stmts(x.ins.then, new Scope(f, sc), f).join(' ');
        if (x.ins.else === undefined) return [...pre, `(if ${c} (then ${t}))`];
        const e = stmts(x.ins.else, new Scope(f, sc), f).join(' ');
        return [...pre, `(if ${c} (then ${t}) (else ${e}))`];
      }
      case 'loop': {
        // while 的形状：`(loop $L (if cond (then 体 步进 (br $L))))`
        // —— **量过的那一条**：`br` 只能跳最内层，所以 while 只能长这个样子。
        const lab = `$L${++loopSeq}`;
        const inner = new Scope(f, sc);
        const body = stmts(x.ins.body, inner, f).join(' ');
        const post = stmts(x.ins.post, inner, f).join(' ');
        const c = cond(x.ins.cond, sc, pre);
        // 条件里若要临时量，那几条得在**每轮**都跑一遍，所以它们进 loop 里面
        return [`(loop ${lab} ${pre.join(' ')} (if ${c} (then ${body} ${post} (br ${lab}))))`];
      }
      case 'ret': {
        if (x.ins.value === undefined) return ['(return)'];
        const v = expr(x.ins.value, sc, pre);
        f.ret = true;
        return [...pre, `(return ${v})`];
      }
      case 'prim': {
        if (x.attrs.name !== 'print') {
          const v = expr(x, sc, pre);
          return [...pre, `(drop ${v})`];
        }
        const args = asList(x.ins.args);
        if (args.length !== 1) throw new Gap('打印只接一格实参（多格要先有字符串拼接）');
        const v = expr(args[0], sc, pre);
        return [...pre, `(call $print ${v})`];
      }
      case 'call': {
        const fn = x.ins.fn;
        const name = fn?.op === 'ref' ? fn.attrs.name : null;
        const call = callOf(x, sc, pre);
        return [...pre, retOf.get(name) === true ? `(drop ${call})` : call];
      }
      default: throw why(x.op, '语句位置');
    }
  }

  /**
   * 一格函数体。**最后一格如果出值，它就是返回值** —— 与 js 后端同一条规矩。
   * 两处例外要挑出来：`print`（wasm 里它不出值）与"调用一格不出值的函数"。
   */
  function fnBody(bodyIns, sc, f) {
    const list = asList(bodyIns);
    if (list.length === 0) return [];
    const head = list.slice(0, -1).flatMap((y) => stmt(y, sc, f));
    const last = list[list.length - 1];
    const voidish = last?.op === 'prim' ? last.attrs.name === 'print'
      : (last?.op === 'call' ? retOf.get(last.ins.fn?.attrs?.name) !== true : false);
    const hasValue = last !== null && last !== undefined && !voidish
      && (last.lit !== undefined || (last.op !== undefined && (NODES.get(last.op)?.outs.length ?? 0) > 0));
    if (!hasValue) return [...head, ...stmt(last, sc, f)];
    const pre = [];
    const v = expr(last, sc, pre);
    f.ret = true;
    return [...head, ...pre, `(return ${v})`];
  }

  // ---- 走一遍顶层：函数各成一格 wat func，别的语句进 `$__entry` --------------
  const entry = mod.fn('$__entry', []);
  const entryScope = new Scope(entry);
  for (const it of items) {
    if (it?.op === 'bind' && it.ins?.init?.op === 'func') {
      const fnode = it.ins.init;
      const params = (fnode.attrs.params ?? []).map((p) => String(p));
      const f = mod.fn(fns.get(it.attrs.name), params);
      const sc = new Scope(f);
      params.forEach((p) => sc.names.set(p, wname(p)));
      f.body = fnBody(fnode.ins.body, sc, f);
      continue;
    }
    entry.body.push(...stmt(it, entryScope, entry));
  }

  const lines = ['(module', '  (import "omni" "print_i64" (func $print (param i64)))'];
  if (needMem) {
    // 一块内存 + 一格堆指针。**从 8 起**：0 号地址留空，好让"没初始化的地址"一眼看出来
    lines.push('  (memory 1)', '  (global $hp (mut i32) (i32.const 8))');
  }
  for (const f of mod.fns.values()) {
    const ps = f.params.map((p) => `(param ${wname(p)} i64)`).join(' ');
    const res = f.ret ? ' (result i64)' : '';
    const locals = f.locals.map((l) => `(local ${l} i64)`).join(' ');
    lines.push(`  (func ${f.name}${ps === '' ? '' : ` ${ps}`}${res}`);
    if (locals !== '') lines.push(`    ${locals}`);
    for (const s of f.body) lines.push(`    ${s}`);
    // 出值的函数要有一条兜底的返回值（wasm 要求每条路径都留下一格结果）
    if (f.ret) lines.push('    (i64.const 0)');
    lines.push('  )');
  }
  lines.push('  (export "main" (func $__entry))', ')');
  return { text: lines.join('\n'), rets: new Map([...mod.fns.values()].map((f) => [f.name, f.ret])) };
}

/**
 * 图 -> WAT 文本。接不住的形状抛 `Gap`（上层把它变成"这一格跳过，理由如下"）。
 */
export function emitWat(graph) {
  const first = emitOnce(graph, new Map());
  // 第二遍：拿着"哪个函数出值"那张表重出一次（语句位置的调用要不要 drop 靠它）
  const byName = new Map();
  const items = asList(graph.kind === 'graph' ? graph.body : graph);
  for (const [src, wat] of topFuncs(items)) byName.set(src, first.rets.get(wat) === true);
  return emitOnce(graph, byName).text;
}

export { Gap };

/**
 * **真跑一遍**：出来的 WAT 交给另一个前端读（`frontend-wat`，WAT -> OIR），
 * 再用 MIR 的解释器跑。输出是靠接管 `process.stdout.write` 收的 ——
 * 那条打印路径（OIR 的 print 内建）本来就是写给宿主 stdout 的，不改它。
 */
export function runWat(text) {
  const diags = new Diagnostics();
  const oir = lowerWat(new SourceFile('graph.wat', text), diags);
  if (oir === null || diags.hasErrors()) {
    throw new Error(`wat 前端不收：${diags.items.map((d) => d.msg).join('; ')}`);
  }
  const out = [];
  const real = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (s) => { buf += String(s); return true; };
  try {
    interpretMir(oir);
  } finally {
    process.stdout.write = real;
  }
  for (const line of buf.split('\n')) if (line !== '') out.push(line);
  return { value: null, out };
}
