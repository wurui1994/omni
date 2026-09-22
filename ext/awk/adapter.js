// ext/awk/adapter.js —— **awk 的树 → 标准 IR**（ADR-0044 第二片的第一门）
//
// 这一份替掉了 `ext/awk/tograph.js`（198 行）。差别不在"少写了多少行"，在**它交出去的
// 是什么**：从前交的是节点图（然后 `backend-core.js` 3339 行把图翻成 `.sx`，顺带替这门
// 语言猜类型），现在交的是 ADR-0044 §1.2 那套标准 IR，语义降级由 `src/core/lower/` 那一份
// 公共降级器做 —— 所有语言同一份。
//
// ## awk 这门语言要 adapter 自己消化的三件事
//
//   1. **没有声明**。`acc = 0` 既是赋值也是"第一次出现"，函数里除了形参没有局部量
//      （`ext/awk/SPEC.md` §四第 1 条）。所以 adapter 自己扫一遍这一段里被赋值的名字，
//      在段顶上补一串 `let`（零值）。从前这一格是"补 bind"，然后类型交给 backend-core 猜。
//   2. **类型**。方言那一层是静态类型、而且**不推导只检查**（`sexpr/lower.js` 的纪律），
//      所以"这个名字装的是什么"必须在这儿答完：扫一遍这一段里所有的写，数是 `int`、
//      串是 `string`、带下标用过的是 `(dict string V)`。**这是这门语言的知识**，
//      不该长在公共降级器里（从前它长在 backend-core 里，那是十一门共用的一份）。
//   3. **真值观**。`while (1)` 里那个 1 是真，`while (n)` 是"n 不为 0"、`while (s)` 是
//      "s 不是空串" —— C 家族与 awk 在这一格上答得不一样，所以它归这儿。
//      从前 backend-core 对"变量当条件"是报缺口的（`(bin "!=" …)` 那一格没人发）。
//
// ## 这一批仍旧明说的不足（**不猜**，与 tograph.js 那份一字不改地继承）
//
//   1. 不接 record-loop / field-view（`$0` / `$1`）与 `END` / pattern-action —— 只收
//      `BEGIN { … }` 与 `function`（`ext/awk/SPEC.md` §3.2：那几格是 awk 私有的）。
//   2. `strnum`（一格值同时是串与数）没接；多维下标（`m[i,j]`）没接。
//   3. **函数里赋值的名字当局部量**。真 awk 里那是全局（局部要靠"多写几个形参"那个惯例），
//      这一格与从前的映射同一个取舍 —— 例子里两者没有差别，改它要连 SPEC 一起改。
//   4. awk 的数只有 double，这儿按 `int` 走（与从前那条路同一个取舍：例子里全是整数）。

import {
  isList, tag, kids, leaf,
} from '../../src/core/lower/cst.js';
import * as sx from '../../src/core/lower/sx.js';

/* ─── 类型（标准 IR 的类型描述，§1.2） ─────────────────────────────────── */

const INT = { kind: 'int' };
const STR = { kind: 'string' };
const BOOL = { kind: 'bool' };
/** awk 的数组就是关联数组 —— 键一律是串。 */
const dictOf = (value) => ({ kind: 'map', key: STR, value });

/** `(name x)` 与光秃秃的 `x` 都要认（`(index m …)` 与 `(in … m)` 的那一格是后者）。 */
const nameOf = (x) => (tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));

/* ─── 扫一段：哪些名字被写过、哪些是数组 ──────────────────────────────── */

/** 被赋值的名字（awk 没有声明 —— 这就是这一段要补的 `let`）。 */
function assignedNames(x, out = new Set()) {
  if (!isList(x)) return out;
  const t = tag(x);
  if (t === 'assign' || t === 'postinc' || t === 'preinc' || t === 'postdec' || t === 'predec') {
    const target = kids(x).find((y) => tag(y) === 'name');
    if (target !== undefined) out.add(nameOf(target));
  }
  for (const k of kids(x)) assignedNames(k, out);
  return out;
}

/** 带下标用过的名字（`m["a"]` / `"a" in m`）—— awk 里那就是一格关联数组。 */
function arrayNames(x, out = new Set()) {
  if (!isList(x)) return out;
  if (tag(x) === 'index') out.add(nameOf(kids(x)[0]));
  if (tag(x) === 'in') out.add(nameOf(kids(x)[1]));
  for (const k of kids(x)) arrayNames(k, out);
  return out;
}

/** 写进某个数组的那些值（推它的值类型用）。 */
function arrayWrites(x, out = []) {
  if (!isList(x)) return out;
  if (tag(x) === 'assign') {
    const [, target, value] = kids(x);
    if (tag(target) === 'index') out.push({ name: nameOf(kids(target)[0]), value });
  }
  for (const k of kids(x)) arrayWrites(k, out);
  return out;
}

/** 赋给某个名字的那些值。 */
function scalarWrites(x, out = []) {
  if (!isList(x)) return out;
  if (tag(x) === 'assign') {
    const [, target, value] = kids(x);
    if (tag(target) === 'name') out.push({ name: nameOf(target), value });
  }
  for (const k of kids(x)) scalarWrites(k, out);
  return out;
}

/* ─── 类型推断（**这一段里所有的写** → 每个名字装什么） ─────────────────── */

/**
 * 一格表达式的类型。回 `INT` / `STR` / `BOOL` 或数组的值类型。
 * `types` 是这一段已经定下来的那张表（边推边查 —— awk 的量都在一个段里）。
 */
function typeOfExpr(x, types) {
  switch (tag(x)) {
    case 'num': return INT;
    case 'str': return STR;
    case 'cat': return STR;                       // 串接
    case 'paren': case 'expr': return typeOfExpr(kids(x)[0], types);
    case 'name': return types.get(nameOf(x)) ?? INT;
    case 'index': {
      const d = types.get(nameOf(kids(x)[0]));
      return d !== undefined && d.kind === 'map' ? d.value : INT;
    }
    case 'in': case 'not': return BOOL;
    case 'neg': return INT;
    case 'bin': {
      const op = leaf(kids(x)[0]);
      return ['<', '>', '<=', '>=', '==', '!=', '&&', '||'].includes(op) ? BOOL : INT;
    }
    case 'call': return INT;                      // 用户函数与 `length` 都回数
    case 'assign': return typeOfExpr(kids(x)[2], types);
    default: return INT;
  }
}

/**
 * 一段（函数体 / BEGIN 块）里每个名字装什么。
 *
 * 次序要紧：数组先定（它决定 `m["k"]` 的类型），再定标量（它们可能读数组）。
 * 同一个名字写过多次而类型不同时**串赢** —— awk 里数能当串用，反过来不行。
 */
function inferTypes(blk, params) {
  const types = new Map();
  for (const p of params) types.set(p, INT);
  const arrays = arrayNames(blk);
  for (const a of arrays) {
    if (params.includes(a)) continue;
    const writes = arrayWrites(blk).filter((w) => w.name === a);
    const vt = writes.length === 0 ? INT
      : (writes.some((w) => typeOfExpr(w.value, types).kind === 'string') ? STR : INT);
    types.set(a, dictOf(vt));
  }
  for (const { name, value } of scalarWrites(blk)) {
    if (params.includes(name) || arrays.has(name)) continue;
    const t = typeOfExpr(value, types);
    const had = types.get(name);
    if (had !== undefined && had.kind === 'string') continue;   // 串赢
    types.set(name, t.kind === 'bool' ? INT : t);               // 条件的值装进量里当 0/1
  }
  return types;
}

/* ─── 树 → 标准 IR ─────────────────────────────────────────────────────── */

/** 真值观：awk 的条件是"不是 0、也不是空串"。字面量在这儿就定下来。 */
function condOf(x, types) {
  const t = tag(x);
  if (t === 'paren' || t === 'expr') return condOf(kids(x)[0], types);
  if (t === 'num') return { kind: 'bool', value: Number(leaf(kids(x)[0])) !== 0 };
  const ty = typeOfExpr(x, types);
  if (ty.kind === 'bool') return exprOf(x, types);
  if (ty.kind === 'string') return { kind: 'binop', op: '!=', left: exprOf(x, types), right: { kind: 'string', value: '' } };
  if (ty.kind === 'int') return { kind: 'binop', op: '!=', left: exprOf(x, types), right: { kind: 'int', value: 0 } };
  throw new Error(`awk->IR: 这一格当条件用还没接（装的是 ${ty.kind}）`);
}

/** `(subscript e)` → 那一格键。多维下标（`m[i,j]`）这一批不接 —— 明说，不猜。 */
function keyOf(sub, types) {
  const ks = tag(sub) === 'subscript' ? kids(sub) : [sub];
  if (ks.length !== 1) throw new Error('awk->IR: 多维下标（m[i,j]）还没接');
  return exprOf(ks[0], types);
}

/** 一格表达式。 */
function exprOf(x, types) {
  switch (tag(x)) {
    case 'num': return { kind: 'int', value: Number(leaf(kids(x)[0])) };
    case 'str': return { kind: 'string', value: leaf(kids(x)[0]) };
    case 'name': return { kind: 'name', name: leaf(kids(x)[0]) };
    case 'paren': case 'expr': return exprOf(kids(x)[0], types);
    /* `m["a"]` → 一格下标读（公共降级器的 `hooks.lowerIndex` 把它发成 `dget`：
       **awk 里没有"数组还是字典"这个问题** —— 所有下标都是关联数组）。 */
    case 'index': return {
      kind: 'index',
      obj: { kind: 'name', name: nameOf(kids(x)[0]) },
      index: keyOf(kids(x)[1], types),
    };
    /* `"a" in m` → 字典问键（与 lua 的 `t[k] ~= nil`、go 的 `_, ok :=` 同一格算子）。 */
    case 'in': return {
      kind: 'builtin',
      name: 'dhas',
      args: [{ kind: 'name', name: nameOf(kids(x)[1]) }, exprOf(kids(x)[0], types)],
    };
    case 'bin': {
      const [op, a, b] = kids(x);
      const o = String(leaf(op));
      /* 与或那两格：两边当条件看（真值观归这门语言）。 */
      if (o === '&&' || o === '||') {
        return { kind: 'binop', op: o, left: condOf(a, types), right: condOf(b, types) };
      }
      return { kind: 'binop', op: o, left: exprOf(a, types), right: exprOf(b, types) };
    }
    case 'cat': {
      /* 串接：awk 里两个表达式挨着写就是接起来。**数要先变成串**（`tostr`）。 */
      const parts = kids(x).map((k) => (typeOfExpr(k, types).kind === 'string'
        ? exprOf(k, types)
        : { kind: 'builtin', name: 'tostr', args: [exprOf(k, types)] }));
      return parts.reduce((a, b) => ({ kind: 'binop', op: '+', left: a, right: b }));
    }
    case 'neg': return { kind: 'unop', op: '-', operand: exprOf(kids(x)[0], types) };
    case 'not': return { kind: 'unop', op: '!', operand: condOf(kids(x)[0], types) };
    case 'call': {
      const fn = leaf(kids(x)[0]);
      const args = kids(x).find((y) => tag(y) === 'args');
      const argNodes = args === undefined ? [] : kids(args).map((a) => exprOf(a, types));
      /* `length(s)` 是 POSIX 的内建，落方言的 `slen` —— 与 lua 的 `#s` 同一格算子
         （写法归语言）。别的内建还没接：它们在树上与用户函数同形，靠的正是这张名字表。 */
      if (fn === 'length' && argNodes.length === 1) {
        return { kind: 'builtin', name: 'slen', args: argNodes };
      }
      return { kind: 'call', fn: { kind: 'name', name: fn }, args: argNodes };
    }
    default:
      throw new Error(`awk->IR: 这一格表达式还没接：${tag(x) ?? String(JSON.stringify(x)).slice(0, 40)}`);
  }
}

/** `a op= b` 就是 `a = a op b`（**不给复合赋值开一格**）。 */
function assignOf(x, types) {
  const [op, target, value] = kids(x);
  const o = String(leaf(op));
  const lhs = tag(target) === 'index'
    ? {
      kind: 'index',
      obj: { kind: 'name', name: nameOf(kids(target)[0]) },
      index: keyOf(kids(target)[1], types),
    }
    : { kind: 'name', name: nameOf(target) };
  if (o === '=') return { kind: 'assign', target: lhs, value: exprOf(value, types) };
  const bare = o.slice(0, -1);
  if (!['+', '-', '*', '/', '%', '^'].includes(bare)) {
    throw new Error(`awk->IR: 这个复合赋值还没接：${o}`);
  }
  return {
    kind: 'assign',
    target: lhs,
    value: { kind: 'binop', op: bare, left: lhs, right: exprOf(value, types) },
  };
}

/** 一格语句。回一条或一组（`block` 那一格摊平）。 */
function stmtOf(x, types) {
  switch (tag(x)) {
    case 'block': return { kind: 'block', stmts: kids(x).map((k) => stmtOf(k, types)) };
    case 'expr': {
      const inner = kids(x)[0];
      if (tag(inner) === 'assign') return assignOf(inner, types);
      if (['postinc', 'preinc', 'postdec', 'predec'].includes(tag(inner))) return stepOf(inner, types);
      return { kind: 'expr-stmt', expr: exprOf(inner, types) };
    }
    case 'assign': return assignOf(x, types);
    case 'postinc': case 'preinc': case 'postdec': case 'predec': return stepOf(x, types);
    case 'print': return { kind: 'print', values: kids(x).map((k) => exprOf(k, types)) };
    case 'if': {
      const [cond, then, els] = kids(x);
      /* `else` 那一格是个包装（`(else (block …))`）—— go / V / awk 三处同一个坑。 */
      const e = els !== undefined && tag(els) === 'else' ? kids(els)[0] : els;
      return {
        kind: 'if',
        cond: condOf(cond, types),
        then: [stmtOf(then, types)],
        else_: e === undefined ? null : [stmtOf(e, types)],
      };
    }
    case 'while': {
      const [cond, ...rest] = kids(x);
      return { kind: 'while', cond: condOf(cond, types), body: rest.map((k) => stmtOf(k, types)) };
    }
    case 'for': {
      /* `for (init; cond; post) stmt` —— 空格子在树上是 `(none)`，不是缺一格。 */
      const [init, cond, post, ...rest] = kids(x);
      const some = (y) => y !== undefined && tag(y) !== 'none';
      return {
        kind: 'for',
        init: some(init) ? stmtOf(init, types) : null,
        cond: some(cond) ? condOf(cond, types) : null,
        post: some(post) ? stmtOf(post, types) : null,
        body: rest.map((k) => stmtOf(k, types)),
      };
    }
    case 'return': {
      const vs = kids(x);
      return { kind: 'return', values: vs.length === 0 ? [] : [exprOf(vs[0], types)] };
    }
    case 'break': return { kind: 'break', label: null };
    case 'continue': return { kind: 'continue', label: null };
    default:
      throw new Error(`awk->IR: 这一格语句还没接：${tag(x) ?? String(JSON.stringify(x)).slice(0, 40)}`);
  }
}

/** `i++` / `i--`：落成"赋值 + 一格算子"（**不开新格**）。 */
function stepOf(x, types) {
  const name = nameOf(kids(x)[0]);
  const op = tag(x).endsWith('inc') ? '+' : '-';
  const target = { kind: 'name', name };
  return {
    kind: 'assign',
    target,
    value: { kind: 'binop', op, left: target, right: { kind: 'int', value: 1 } },
  };
}

/**
 * 一段体（函数体 / BEGIN 块）：**先补声明**（awk 没有声明），再放语句。
 * 零值由公共降级器按类型给（`lower/ty.js` 的 `zeroOf`）—— awk 里没赋过值的量
 * 当数是 0、当串是 ""，正好都是零值。
 */
function bodyOf(blk, params, types) {
  const stmts = blk === undefined ? [] : kids(blk).map((k) => stmtOf(k, types));
  const decls = [];
  for (const [name, type] of types) {
    if (params.includes(name)) continue;
    decls.push({ kind: 'let', name, type, init: null });
  }
  return [...decls, ...stmts];
}

/**
 * 一棵 awk 的 GLR 树（`(program 项…)`）→ 标准 IR 的模块。
 *
 * `BEGIN` 那一段是入口（`{ kind: 'main' }`），`function` 是函数。别的 pattern-action
 * 当场报 —— 那要 record-loop（见文件头第 1 条）。
 */
export function awkToIR(tree) {
  if (tag(tree) !== 'program') throw new Error('awk->IR: 这不是 (program …)');
  const decls = [];
  const mainBody = [];
  for (const item of kids(tree)) {
    if (tag(item) === 'fn') {
      const name = leaf(kids(item)[0]);
      const ps = kids(item).find((y) => tag(y) === 'params');
      const params = ps === undefined ? [] : kids(ps).map((p) => leaf(p));
      const blk = kids(item).find((y) => tag(y) === 'block');
      const types = inferTypes(blk, params);
      const body = bodyOf(blk, params, types);
      /* 回什么：有一格带值的 `return` 就是 `int`（awk 的数），一格都没有就是 void。 */
      const hasValue = body.some((s) => hasValueReturn(s));
      decls.push({
        kind: 'fn',
        name,
        params: params.map((p) => ({ name: p, type: INT })),
        ret: hasValue ? INT : { kind: 'void' },
        body,
      });
      continue;
    }
    if (tag(item) === 'rule') {
      const pat = kids(item)[0];
      const blk = kids(item).find((y) => tag(y) === 'block');
      if (tag(pat) !== 'begin') {
        throw new Error('awk->IR: 这一批只接 BEGIN —— 别的 pattern-action 要 record-loop'
          + '（ext/awk/SPEC.md §3.2：那是只有 awk 一家的节点，还没做）');
      }
      const types = inferTypes(blk, []);
      mainBody.push(...bodyOf(blk, [], types));
      continue;
    }
    throw new Error(`awk->IR: 这一格顶层还没接：${tag(item)}`);
  }
  decls.push({ kind: 'main', body: mainBody });
  return { kind: 'module', decls };
}

/** 这条语句（或它里头）有没有一格**带值的** `return`。 */
function hasValueReturn(s) {
  if (s === null || s === undefined) return false;
  if (s.kind === 'return') return s.values.length > 0;
  for (const k of ['then', 'else_', 'body', 'stmts']) {
    const v = s[k];
    if (Array.isArray(v) && v.some((y) => hasValueReturn(y))) return true;
  }
  if (s.kind === 'for' && (hasValueReturn(s.init) || hasValueReturn(s.post))) return true;
  return false;
}

/**
 * 这门语言交给公共降级器的那几条语义（ADR-0044 §1.4）。
 *
 * 只有两格：下标读写是**字典**（awk 的数组就是关联数组，没有第二种可能）。
 * 别的（真值观、类型、没有声明）在上面就消化掉了 —— 那才是 adapter 的活。
 */
export const AWK_HOOKS = {
  lowerIndex: (e, obj, idx) => sx.dget(obj, idx),
  lowerAssign: (s, ctx) => {
    if (s.target.kind !== 'index') return null;
    const obj = ctx.lowerExpr(s.target.obj, ctx);
    const key = ctx.lowerExpr(s.target.index, ctx);
    return sx.dset(obj, key, ctx.lowerExpr(s.value, ctx));
  },
};
