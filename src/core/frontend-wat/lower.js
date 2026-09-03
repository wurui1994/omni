// Omni stage0 — WAT（WebAssembly 文本格式）-> OIR
//
// 这是 S 表达式那条路径上的**第一个真语法前端**（ADR-0014 决策 1）。挑 WAT 不是因为
// 我们要跑 wasm，而是因为它给了这条路径一份**别人写好的规格**：一套公开的指令表、
// 一套公开的语义、一堆现成的素材。自己发明的 s-expr 方言没有这些。
//
// 它同时把「一份 S-EXPR -> OIR 的降级」这句话从口号变成可测的东西：在它出现之前，
// OIR 只有 JS 前端和 Omni 前端两个生产者，两者都是同一批人同一天写的，接口对不对
// 没有第三方来证。现在有了。
//
// ## 第一阶段的边界（刻意的，全部报错而不是给错答案）
//
// - **折叠形式**（`(i32.add (local.get $x) (i32.const 1))`）才认。平铺的栈式写法
//   （`local.get $x` `i32.const 1` `i32.add` 各占一行）不认 —— 那要在编译期模拟一遍
//   操作数栈，和控制流搅在一起是另一件事。
// - 类型只有 `i32` / `i64` / `f64`。`f32` 不认：OIR 只有 double，硬塞会在舍入上撒谎。
// - `i32` 的值在 OIR 里**始终以符号扩展后的 int64 保存**。于是无符号那一族
//   （`div_u` / `shr_u` / `lt_u` …）能靠零扩展一步做对，见 zext32 的注释。
// - `i64` 的无符号一族**不认**：那要真正的 64 位无符号，int64 表示不出来。
// - `br` / `br_if` 只能跳最内层的那个 `block` / `loop`（或整个函数 = return）。
//   OIR 只有 break/continue，没有带标签的跳转。跳更外层会明确报错。
// - `block` / `loop` / `if` 不能带 `(result ...)`：它们在这里是语句，不是表达式。
// - 表、`call_indirect`、`br_table` 一律不认。**线性内存与全局量已经认了**（ADR-0017
//   第四刀）：那两格在 ADR-0017 第二刀里长进了核心方言与五条腿，这里只是把 wasm 的
//   写法接上去 —— 于是同一套内存语义有了**第二个互不相干的前端**来证。
// - **求值顺序没有钉死**。wasm 是栈机，操作数必然从左到右求值；OIR 的 Bin/Call 落到 C
//   之后，实参顺序是 unspecified。所以「在同一条指令里既 `local.tee $x` 又 `local.get $x`」
//   这种写法在三个执行器上可以给出不同答案。这不是能靠报错挡住的（要挡就得做副作用分析），
//   所以记在这里：真要顺序，就拆成两条语句。
//
// ## 宿主面
//
// wasm 自己没有输出能力，靠 import。这里只认一个模块名 `omni`，三条：
//   (import "omni" "print_i32" (func $p (param i32)))
//   (import "omni" "print_i64" (func $p (param i64)))
//   (import "omni" "print_f64" (func $p (param f64)))
// 它们直接降成 OIR 的 print 内建（和 Omni 源码里的 `print` 是同一条），所以格式、
// 换行、四个执行器之间的一致性全都是现成的。
//
// ## 入口
//
// `(start $f)` 优先，其次是导出名为 `"main"` 的函数。两个都没有就报错。

import { INT, REAL, BOOL, STRING, VOID, zeroValue } from '../hir/types.js';
import { readSexpr, isList, isAtom, isStr, head } from '../sexpr/read.js';
import { utf8Bytes } from '../host/utf8.js';

/** wasm 值类型 -> OIR 类型。i32 与 i64 都落在 int 上，区别只在算术要不要回绕。 */
const OIR_TYPE = { i32: INT, i64: INT, f64: REAL };

/** 只能出现在语句位置的指令（不产生值）。`call` 要看被调者有没有结果，单独判。 */
const STMT_HEADS = new Set([
  'nop', 'unreachable', 'drop', 'local.set', 'br', 'br_if', 'return', 'block', 'loop', 'if',
  'global.set',
]);

/* ------------------------------------------------- 线性内存（ADR-0017 第四刀）
 * wasm 的 load/store 指令名 -> 核心方言 `mload`/`mstore` 的 KIND。这张表就是
 * 「一族指令 = 一条 op + 一个描述符」那句话的另一半：wasm 把宽度与符号写进指令名，
 * 我们写进描述符，两边逐条对得上。
 *
 * `i32.load` 落到 `i32s` 而不是 `i32u`：这个前端里 i32 的表示是**符号扩展后的 int64**
 * （见文件头），所以读 4 个字节要按有符号扩展 —— 与 wasm 的「i32 就是那 32 位」一致。
 * `i64.load32_u` 才是零扩展的那一条，而 wasm 里也**没有** `i32.load32_u`。
 * f32 那两条不认：这个前端没有 f32（OIR 只有 double，硬塞会在舍入上撒谎）。
 */
const MEM_LOAD_OP = {
  'i32.load': 'i32s', 'i32.load8_s': 'i8s', 'i32.load8_u': 'i8u',
  'i32.load16_s': 'i16s', 'i32.load16_u': 'i16u',
  'i64.load': 'i64', 'i64.load8_s': 'i8s', 'i64.load8_u': 'i8u',
  'i64.load16_s': 'i16s', 'i64.load16_u': 'i16u',
  'i64.load32_s': 'i32s', 'i64.load32_u': 'i32u',
  'f64.load': 'f64',
};
const MEM_STORE_OP = {
  'i32.store': 'i32', 'i32.store8': 'i8', 'i32.store16': 'i16',
  'i64.store': 'i64', 'i64.store8': 'i8', 'i64.store16': 'i16', 'i64.store32': 'i32',
  'f64.store': 'f64',
};

const iconst = (v) => ({ kind: 'Const', type: INT, value: BigInt(v) });
const rconst = (v) => ({ kind: 'Const', type: REAL, value: v });
const ibin = (op, a, b) => ({ kind: 'Bin', op, opType: INT, left: a, right: b, type: INT });
const rbin = (op, a, b) => ({ kind: 'Bin', op, opType: REAL, left: a, right: b, type: REAL });
const cmp = (op, t, a, b) => ({ kind: 'Cmp', op, opType: t, left: a, right: b, type: BOOL });
const oirBlock = (stmts) => ({ kind: 'Block', stmts });

/** i32 的回绕：左移 32 再算术右移 32，就是符号扩展。两条 int 运算，没有分支。 */
const wrap32 = (e) => ibin('>>', ibin('<<', e, iconst(32)), iconst(32));
/** 零扩展。i32 的无符号比较/除法/逻辑右移全靠它：零扩展之后 int64 的有符号运算就是对的。 */
const zext32 = (e) => ibin('&', e, iconst(0xffffffffn));

/** 宿主面：模块名 `omni` 下认这三条，直接降成 OIR 的 print 内建 */
const HOST_FUNCS = {
  print_i32: { params: ['i32'], results: [], argType: INT },
  print_i64: { params: ['i64'], results: [], argType: INT },
  print_f64: { params: ['f64'], results: [], argType: REAL },
};

class LowerWat {
  constructor(diags) {
    this.diags = diags;
    /** @type {{name:string, mangled:string, params:{name:string,wt:string}[], results:string[], locals:{name:string,wt:string}[], body:any[], host:string|null, exportName:string|null, span:any}[]} */
    this.decls = [];
    /** `$name` -> decls 下标。数字下标直接就是 decls 的下标。 */
    this.funcNames = new Map();
    this.usedMangled = new Set(['omni_main']);
    this.startRef = null;
    // 线性内存与全局量（ADR-0017 第四刀）。两者都是**模块级**的，所以在这一层，
    // 不在 ctx 里 —— 函数体只是引用它们。
    this.mem = null;              // {min, max, data:[{off, bytes}]}
    this.globals = [];            // {wasmName, name, wt, mut, init}
    this.globalNames = new Map(); // `$g` -> globals 下标
    this.usedGlobalNames = new Set();
  }

  err(span, msg) {
    this.diags.error(span, msg);
  }

  /**
   * 光秃秃一个 atom 出现在指令位置 —— 这就是平铺栈式写法的样子（`i32.const 1` 独占一行）。
   * 报"expected an instruction"没用，得说清楚为什么：只认折叠形式。
   */
  notFolded(n) {
    if (isAtom(n)) {
      this.err(n.span, `'${n.value}' stands alone: only the folded form is supported, so write (${n.value} ...) with its operands nested inside`);
      return;
    }
    this.err(n === undefined || n === null ? null : n.span, 'expected an instruction');
  }

  /** 名字 -> C 安全且唯一的符号。`$fib` -> `w_fib`，撞了就加尾号。 */
  mangle(name) {
    const base = `w_${String(name).replace(/[^A-Za-z0-9_]/g, '_')}`;
    let m = base;
    for (let n = 2; this.usedMangled.has(m); n++) m = `${base}_${n}`;
    this.usedMangled.add(m);
    return m;
  }

  /** `(param $x i32)` / `(local $x i32)` / `(result i32)` 里的值类型 */
  valType(n) {
    if (isAtom(n) && OIR_TYPE[n.value] !== undefined) return n.value;
    if (isAtom(n)) {
      this.err(n.span, `value type '${n.value}' is not supported yet (only i32 / i64 / f64)`);
      return null;
    }
    this.err(n ? n.span : null, 'expected a value type');
    return null;
  }

  // ---------------------------------------------------------------- 模块与声明

  /**
   * 顶层。一份文件要么是一个 `(module ...)`，要么直接是一串模块字段
   * （WAT 的省略形式），两种都收。
   */
  module(nodes) {
    let fields = nodes;
    if (nodes.length === 1 && head(nodes[0]) === 'module') {
      fields = nodes[0].items.slice(1);
      // `(module $name ...)`：模块名对我们没用，跳过
      if (isAtom(fields[0]) && fields[0].value.startsWith('$')) fields = fields.slice(1);
    }
    // 两遍：先把所有函数登记进符号表，`call` 才能往前引用
    for (const f of fields) this.declare(f);
    for (const d of this.decls) if (d.host === null) this.lowerBody(d);
    return this.finish(fields);
  }

  declare(f) {
    const h = head(f);
    if (h === 'func') return this.declareFunc(f);
    if (h === 'import') return this.declareImport(f);
    if (h === 'memory') return this.declareMemory(f);
    if (h === 'data') return this.declareData(f);
    if (h === 'global') return this.declareGlobal(f);
    if (h === 'export' || h === 'start') return;   // 第二遍处理，那时函数都在表里了
    if (h === null) {
      this.err(f.span, 'expected a module field like (func ...) / (import ...) / (start ...)');
      return;
    }
    this.err(f.span, `module field '${h}' is not supported yet (func / import / export / start / memory / data / global)`);
  }

  /**
   * `(memory MIN [MAX])`。一个模块一块（wasm 的 MVP 就是这样），所以不带名字也不带下标。
   * `(memory (export "mem") 1)` 那种内联导出不认：导出对我们没有意义（没有宿主来 import）。
   */
  declareMemory(f) {
    if (this.mem !== null) {
      this.err(f.span, 'only one memory is supported (wasm MVP has exactly one)');
      return;
    }
    const items = f.items.slice(1);
    const pages = (n, what) => {
      const v = n === undefined ? null : intLit(n, 64);
      if (v === null || v < 0n || v > 65536n) {
        this.err((n ?? f).span, `(memory MIN [MAX]) needs ${what} between 0 and 65536 pages`);
        return null;
      }
      return Number(v);
    };
    const min = pages(items[0], 'a minimum');
    if (min === null) return;
    let max = 0;
    if (items.length > 1) {
      const m = pages(items[1], 'a maximum');
      if (m === null) return;
      if (m < min) {
        this.err(f.span, `the memory maximum (${m}) is below the minimum (${min})`);
        return;
      }
      max = m;
    }
    if (items.length > 2) {
      this.err(items[2].span, '(memory MIN [MAX]) takes at most two numbers');
      return;
    }
    this.mem = { min, max, data: [] };
  }

  /**
   * `(data (i32.const OFF) 字节…)`。
   *
   * **与 WAT 规范刻意的一处不同**：字节写成字符串（按 UTF-8 展开）或 0..255 的整数，
   * 而**不认 WAT 的 `\hh` 转义**。理由是读取器是共用的（sexpr/read.js，六个前端一份）：
   * 它认 `\n` / `\u{...}` 那一套，加一条「两位十六进制、无前缀」的转义就会同时改掉 sx
   * 方言的词法，而那条轴上「源码 -> 树 -> 文本 -> 树」是要逐节点相同的。整数写法与
   * 核心方言的 `(data OFF 字节…)` 是同一种，所以这一处不同不引入第二套概念。
   */
  declareData(f) {
    if (this.mem === null) {
      this.err(f.span, '(data ...) needs a (memory ...) field before it');
      return;
    }
    const items = f.items.slice(1);
    const offNode = items[0];
    let off = null;
    // `(i32.const N)`、`(offset (i32.const N))`，或者干脆一个数
    let inner = offNode;
    if (head(inner) === 'offset') inner = inner.items[1];
    if (head(inner) === 'i32.const' || head(inner) === 'i64.const') {
      off = intLit(inner.items[1], 64);
    } else if (isAtom(inner)) {
      off = intLit(inner, 64);
    }
    if (off === null || off < 0n) {
      this.err((offNode ?? f).span, '(data OFFSET ...) needs (i32.const N) with a non-negative N');
      return;
    }
    const bytes = [];
    for (const it of items.slice(1)) {
      if (isStr(it)) {
        for (const b of utf8Bytes(it.value)) bytes.push(b);
        continue;
      }
      const v = intLit(it, 64);
      if (v === null || v < 0n || v > 255n) {
        this.err(it.span, 'data bytes are strings or integers in 0..255');
        return;
      }
      bytes.push(Number(v));
    }
    const end = Number(off) + bytes.length;
    if (end > this.mem.min * 65536) {
      this.err(f.span, `this data segment ends at ${end}, past the declared ${this.mem.min} page(s) (${this.mem.min * 65536} bytes)`);
      return;
    }
    this.mem.data.push({ off: Number(off), bytes });
  }

  /**
   * `(global $g (mut i32) (i32.const 7))` / `(global $g i32 (i32.const 7))`。
   *
   * 初值只认常量指令（wasm 的 const expr 也只允许 `T.const` 与 `global.get` 一个已定义的
   * 不可变全局；后者不认 —— 它要求全局之间有个初始化顺序，而那件事没有第二个用户）。
   * 不可变的全局写起来会被拒（`global.set`），这是 wasm 校验器的规则，不是我们加的限制。
   */
  declareGlobal(f) {
    const items = f.items.slice(1);
    let k = 0;
    let wasmName = null;
    if (isAtom(items[k]) && items[k].value.startsWith('$')) wasmName = items[k++].value;
    let tyNode = items[k++];
    let mut = false;
    if (head(tyNode) === 'mut') { mut = true; tyNode = tyNode.items[1]; }
    const wt = this.valType(tyNode);
    if (wt === null) return;
    const initNode = items[k];
    if (initNode === undefined) {
      this.err(f.span, '(global ...) needs an initializer like (i32.const 0)');
      return;
    }
    const ih = head(initNode);
    let init = null;
    if (ih === 'i32.const' || ih === 'i64.const') {
      const v = intLit(initNode.items[1], wt === 'i32' ? 32 : 64);
      if (v !== null && OIR_TYPE[wt] === INT) init = { kind: 'Const', type: INT, value: v };
    } else if (ih === 'f64.const') {
      const v = floatLit(initNode.items[1]);
      if (v !== null && wt === 'f64') init = rconst(v);
    }
    if (init === null) {
      this.err(initNode.span, `a global initializer must be a (${wt}.const ...) literal`);
      return;
    }
    if (items.length > k + 1) {
      this.err(items[k + 1].span, '(global ...) takes one initializer');
      return;
    }
    // 名字：`$sp` -> `sp`，撞了加尾号。OIR 的全局是按名字找的，所以要唯一且 C 安全。
    const base = (wasmName === null ? `g${this.globals.length}` : wasmName.slice(1))
      .replace(/[^A-Za-z0-9_]/g, '_') || `g${this.globals.length}`;
    let nm = base;
    for (let n = 2; this.usedGlobalNames.has(nm); n++) nm = `${base}_${n}`;
    this.usedGlobalNames.add(nm);
    if (wasmName !== null) {
      if (this.globalNames.has(wasmName)) this.err(f.span, `duplicate global name '${wasmName}'`);
      else this.globalNames.set(wasmName, this.globals.length);
    }
    this.globals.push({ wasmName, name: nm, wt, mut, init });
  }

  /** `$name` 或数字下标 -> 全局 */
  resolveGlobal(n) {
    if (!isAtom(n)) {
      this.err(n ? n.span : null, 'expected a global name or index');
      return null;
    }
    if (n.value.startsWith('$')) {
      const i = this.globalNames.get(n.value);
      if (i === undefined) {
        this.err(n.span, `unknown global '${n.value}'`);
        return null;
      }
      return this.globals[i];
    }
    const i = Number.parseInt(n.value, 10);
    if (!Number.isInteger(i) || i < 0 || i >= this.globals.length) {
      this.err(n.span, `global index ${n.value} is out of range`);
      return null;
    }
    return this.globals[i];
  }

  /** 登记一个函数，把签名、局部量、函数体分开存好；函数体这一遍不看 */
  declareFunc(f) {
    const items = f.items.slice(1);
    let k = 0;
    let name = null;
    if (isAtom(items[k]) && items[k].value.startsWith('$')) name = items[k++].value;
    let exportName = null;
    const params = [];
    const results = [];
    const locals = [];
    for (; k < items.length; k++) {
      const it = items[k];
      const ih = head(it);
      if (ih === 'export') {
        if (!isStr(it.items[1])) this.err(it.span, '(export ...) needs a string name');
        else exportName = it.items[1].value;
        continue;
      }
      if (ih === 'import') {
        this.err(it.span, 'the inline (import ...) form on a func is not supported yet');
        continue;
      }
      if (ih === 'type') {
        this.err(it.span, '(type ...) references are not supported yet: spell the signature out');
        continue;
      }
      if (ih === 'param' || ih === 'local') {
        const into = ih === 'param' ? params : locals;
        const rest = it.items.slice(1);
        if (rest.length === 2 && isAtom(rest[0]) && rest[0].value.startsWith('$')) {
          const wt = this.valType(rest[1]);
          if (wt) into.push({ name: rest[0].value, wt });
          continue;
        }
        // 匿名的可以一条写好几个：`(param i32 i32)`
        for (const t of rest) {
          const wt = this.valType(t);
          if (wt) into.push({ name: null, wt });
        }
        continue;
      }
      if (ih === 'result') {
        for (const t of it.items.slice(1)) {
          const wt = this.valType(t);
          if (wt) results.push(wt);
        }
        continue;
      }
      break;   // 剩下的全是函数体
    }
    if (results.length > 1) {
      this.err(f.span, 'multiple results are not supported yet (OIR functions return one value)');
      results.length = 1;
    }
    this.push({ name, exportName, params, results, locals, body: items.slice(k), host: null, span: f.span });
  }

  /** `(import "omni" "print_i64" (func $p (param i64)))` */
  declareImport(f) {
    const [, mod, field, desc] = f.items;
    if (!isStr(mod) || !isStr(field)) {
      this.err(f.span, '(import ...) needs two string names');
      return;
    }
    if (mod.value !== 'omni') {
      this.err(f.span, `only the 'omni' import module is available (found ${JSON.stringify(mod.value)})`);
      return;
    }
    const spec = HOST_FUNCS[field.value];
    if (spec === undefined) {
      const have = Object.keys(HOST_FUNCS).join(' / ');
      this.err(f.span, `'omni.${field.value}' is not a host function; available: ${have}`);
      return;
    }
    if (head(desc) !== 'func') {
      this.err(f.span, 'only (func ...) imports are supported');
      return;
    }
    const items = desc.items.slice(1);
    const name = isAtom(items[0]) && items[0].value.startsWith('$') ? items[0].value : null;
    this.push({
      name, exportName: null, params: spec.params.map((wt) => ({ name: null, wt })),
      results: spec.results, locals: [], body: [], host: field.value, span: f.span,
    });
  }

  push(d) {
    d.mangled = this.mangle(d.name ?? `f${this.decls.length}`);
    if (d.name !== null) {
      if (this.funcNames.has(d.name)) this.err(d.span, `duplicate function name '${d.name}'`);
      else this.funcNames.set(d.name, this.decls.length);
    }
    this.decls.push(d);
  }

  /** 名字或数字下标 -> 声明 */
  resolveFunc(n) {
    if (!isAtom(n)) {
      this.err(n ? n.span : null, 'expected a function name or index');
      return null;
    }
    if (n.value.startsWith('$')) {
      const i = this.funcNames.get(n.value);
      if (i === undefined) {
        this.err(n.span, `unknown function '${n.value}'`);
        return null;
      }
      return this.decls[i];
    }
    const i = Number.parseInt(n.value, 10);
    if (!Number.isInteger(i) || i < 0 || i >= this.decls.length) {
      this.err(n.span, `function index ${n.value} is out of range`);
      return null;
    }
    return this.decls[i];
  }

  // ---------------------------------------------------------------- 函数体

  /** 局部量的槽位：参数在前、`(local ...)` 在后，编号连续 —— wasm 的规矩 */
  slots(d) {
    const used = new Set();
    const uniq = (raw, pos) => {
      const base = raw === null ? `l${pos}` : raw.slice(1).replace(/[^A-Za-z0-9_]/g, '_') || `l${pos}`;
      let n = base;
      for (let k = 2; used.has(n); k++) n = `${base}_${k}`;
      used.add(n);
      return n;
    };
    const all = [...d.params, ...d.locals];
    const slots = [];
    const byName = new Map();
    for (let idx = 0; idx < all.length; idx++) {
      const s = all[idx];
      slots.push({ wt: s.wt, wasm: s.name, name: uniq(s.name, idx) });
      if (s.name !== null) byName.set(s.name, idx);
    }
    return { slots, byName, nParams: d.params.length };
  }

  lowerBody(d) {
    const ctx = { d, ...this.slots(d), labels: [] };
    const out = [];
    // `(local ...)` 在 OIR 里是带零初始化的 Local 语句；参数是真参数，不在这儿声明
    for (let i = ctx.nParams; i < ctx.slots.length; i++) {
      const s = ctx.slots[i];
      out.push({ kind: 'Local', name: s.name, type: OIR_TYPE[s.wt], init: zeroValue(OIR_TYPE[s.wt]) });
    }
    const ret = d.results.length === 0 ? VOID : OIR_TYPE[d.results[0]];
    const body = d.body;
    for (let i = 0; i < body.length; i++) {
      const last = i === body.length - 1;
      // 函数体最后那条指令留在栈上的值就是返回值 —— wasm 的规矩，也是最常见的写法
      if (last && ret !== VOID && !this.isStmtOnly(body[i], ctx)) {
        const v = this.value(body[i], ctx);
        out.push({ kind: 'Return', value: v === null ? zeroValue(ret) : this.coerce(v, d.results[0], body[i].span) });
        continue;
      }
      this.stmt(body[i], out, ctx);
    }
    // OIR 要求非 void 的函数每条路径都返回；wasm 允许最后是 unreachable/br，所以兜一条
    if (out.length === 0 || out[out.length - 1].kind !== 'Return') {
      out.push({ kind: 'Return', value: ret === VOID ? null : zeroValue(ret) });
    }
    d.func = {
      name: d.name ?? d.mangled,
      mangled: d.mangled,
      ret,
      params: ctx.slots.slice(0, ctx.nParams).map((s) => ({ name: s.name, type: OIR_TYPE[s.wt] })),
      body: oirBlock(out),
    };
  }

  /** 这条指令只能当语句用吗？（决定函数体最后一条要不要变成 Return） */
  isStmtOnly(n, ctx) {
    const h = head(n);
    if (h === null) return true;
    if (STMT_HEADS.has(h)) return true;
    if (MEM_STORE_OP[h] !== undefined) return true;
    if (h === 'call') {
      const d = this.resolveFunc(n.items[1]);
      return d === null || d.results.length === 0;
    }
    return false;
  }

  // ---------------------------------------------------------------- 语句

  stmt(n, out, ctx) {
    const h = head(n);
    // 存指令没有结果，所以它只能是语句（wasm 校验器也这么看）
    if (MEM_STORE_OP[h] !== undefined) { this.memStore(n, h, ctx, out); return; }
    switch (h) {
      case 'nop':
        return;
      case 'unreachable':
        out.push({ kind: 'ExprStmt', expr: { kind: 'Builtin', name: 'fail', args: [{ kind: 'Const', type: STRING, value: 'wasm: unreachable' }], type: VOID } });
        return;
      case 'drop': {
        const v = this.value(n.items[1], ctx);
        if (v !== null) out.push({ kind: 'ExprStmt', expr: v.e });
        return;
      }
      case 'local.set': {
        const a = this.assignLocal(n, ctx);
        if (a !== null) out.push({ kind: 'ExprStmt', expr: a.e });
        return;
      }
      case 'global.set': {
        const a = this.assignGlobal(n, ctx);
        if (a !== null) out.push({ kind: 'ExprStmt', expr: a.e });
        return;
      }
      case 'return': {
        const ret = ctx.d.results;
        if (n.items.length === 1) {
          out.push({ kind: 'Return', value: ret.length === 0 ? null : zeroValue(OIR_TYPE[ret[0]]) });
          return;
        }
        const v = this.value(n.items[1], ctx);
        if (ret.length === 0) {
          this.err(n.span, 'this function has no result, so (return ...) takes no value');
          return;
        }
        out.push({ kind: 'Return', value: v === null ? zeroValue(OIR_TYPE[ret[0]]) : this.coerce(v, ret[0], n.span) });
        return;
      }
      case 'block': case 'loop': {
        const items = n.items.slice(1);
        let k = 0;
        let label = null;
        if (isAtom(items[k]) && items[k].value.startsWith('$')) {
          label = items[k].value;
          k++;
        }
        if (head(items[k]) === 'result') {
          this.err(items[k].span, `(result ...) on a ${h} is not supported yet: it would make the ${h} an expression`);
          return;
        }
        // block 与 loop 在 OIR 里是同一个形状 —— `while (true) { ...; break; }`。
        // 区别只在 br 落到哪：block 的 br 是"跳出去"（break），loop 的是"从头再来"（continue）。
        ctx.labels.push({ name: label, kind: h });
        const inner = [];
        for (const it of items.slice(k)) this.stmt(it, inner, ctx);
        ctx.labels.pop();
        inner.push({ kind: 'Break' });
        out.push({ kind: 'While', cond: { kind: 'Const', type: BOOL, value: true }, body: oirBlock(inner) });
        return;
      }
      case 'br': case 'br_if': {
        const jump = this.branch(n, ctx);
        if (jump === null) return;
        if (h === 'br') {
          out.push(jump.stmt);
          return;
        }
        const c = this.cond(this.value(jump.condNode, ctx), jump.condNode);
        if (c === null) return;
        out.push({ kind: 'If', cond: c, then: oirBlock([jump.stmt]), otherwise: null });
        return;
      }
      case 'if': {
        const items = n.items.slice(1);
        let k = 0;
        if (isAtom(items[k]) && items[k].value.startsWith('$')) {
          this.err(items[k].span, 'a label on (if ...) is not supported yet');
          return;
        }
        if (head(items[k]) === 'result') {
          this.err(items[k].span, '(result ...) on an if is not supported yet: it would make the if an expression');
          return;
        }
        if (items[k] === undefined || head(items[k]) === 'then') {
          this.err(n.span, 'the folded (if COND (then ...)) form is required: the condition comes before (then ...)');
          return;
        }
        const c = this.cond(this.value(items[k], ctx), items[k]);
        k++;
        const thenN = items[k];
        if (head(thenN) !== 'then') {
          this.err(n.span, 'expected (then ...) after the condition');
          return;
        }
        const elseN = items[k + 1];
        if (elseN !== undefined && head(elseN) !== 'else') {
          this.err(elseN.span, 'expected (else ...) or nothing after (then ...)');
          return;
        }
        if (c === null) return;
        const thenOut = [];
        for (const it of thenN.items.slice(1)) this.stmt(it, thenOut, ctx);
        const elseOut = [];
        if (elseN !== undefined) for (const it of elseN.items.slice(1)) this.stmt(it, elseOut, ctx);
        out.push({ kind: 'If', cond: c, then: oirBlock(thenOut), otherwise: elseOut.length ? oirBlock(elseOut) : null });
        return;
      }
      case 'call': {
        const v = this.call(n, ctx);
        if (v === null) return;
        if (v.t !== 'void') {
          this.err(n.span, `this call returns ${v.t} and nothing consumes it; wrap it in (drop ...)`);
          return;
        }
        out.push({ kind: 'ExprStmt', expr: v.e });
        return;
      }
      default: {
        // 剩下的都是会产生值的指令。在语句位置出现意味着它的值被丢在栈上没人要 ——
        // wasm 校验器会拒绝这种模块，所以这里也拒绝，而不是悄悄当 drop。
        if (h === null) {
          this.notFolded(n);
          return;
        }
        const v = this.value(n, ctx);
        if (v !== null) {
          this.err(n.span, `'${h}' produces a value that nothing consumes; only the folded form is supported, so operands must be nested inside the instruction that uses them`);
        }
      }
    }
  }

  /**
   * `br` / `br_if` 的目标。OIR 只有 break/continue，所以只有两种目标能翻：
   * 最内层的那个 block/loop，以及整个函数体（= return）。
   */
  branch(n, ctx) {
    const target = n.items[1];
    const condNode = head(n) === 'br_if' ? n.items[2] : null;
    if (head(n) === 'br_if' && condNode === undefined) {
      this.err(n.span, '(br_if LABEL COND) needs a condition');
      return null;
    }
    if (!isAtom(target)) {
      this.err(n.span, 'expected a label or depth after br');
      return null;
    }
    // 标签名转深度：从里往外数。手写倒序循环而不是 findLastIndex —— 后者不在封闭 ABI 里
    // （量出来的：node 上照跑，原生构建里当场变成"在 list 上取属性"）。
    let depth = -1;
    if (target.value.startsWith('$')) {
      for (let i = ctx.labels.length - 1; i >= 0; i--) {
        if (ctx.labels[i].name === target.value) {
          depth = ctx.labels.length - 1 - i;
          break;
        }
      }
      if (depth < 0) {
        this.err(target.span, `unknown label '${target.value}'`);
        return null;
      }
    } else {
      depth = Number.parseInt(target.value, 10);
      if (!Number.isInteger(depth) || depth < 0 || depth > ctx.labels.length) {
        this.err(target.span, `branch depth ${target.value} is out of range`);
        return null;
      }
    }
    if (depth === ctx.labels.length) {
      // 跳到函数体这一层就是 return。带值的形式 `(br N V)` 不接：在折叠写法里那个 V 会
      // 和 br_if 的条件抢同一个位置，猜错就是错答案。有结果的函数请直接写 return。
      if (ctx.d.results.length !== 0) {
        this.err(target.span, 'br to the function block is only supported when the function has no result; use (return ...) instead');
        return null;
      }
      return { stmt: { kind: 'Return', value: null }, condNode };
    }
    if (depth !== 0) {
      this.err(target.span, `br to a non-innermost label is not supported yet (OIR has no labeled break); target depth ${depth}`);
      return null;
    }
    const l = ctx.labels[ctx.labels.length - 1];
    return { stmt: { kind: l.kind === 'loop' ? 'Continue' : 'Break' }, condNode };
  }

  // ---------------------------------------------------------------- 值

  /**
   * 值的口径：`{e, t}`，t 是 `'i32' | 'i64' | 'f64' | 'bool'`。
   *
   * `'bool'` 是只在这一层里存在的伪类型 —— wasm 的比较结果是 i32（0/1），而 OIR 的 Cmp
   * 出来的是 bool。中间留着 bool，`(if (i32.lt_s a b) ...)` 就能直接用；真被当成 i32
   * 的值消费时才在 coerce 里摊成 0/1。少了这一步每个比较都要多一次三元。
   */
  value(n, ctx) {
    const h = head(n);
    if (h === null) {
      this.notFolded(n);
      return null;
    }
    if (h === 'local.get') {
      const s = this.localSlot(n.items[1], ctx);
      if (s === null) return null;
      return { e: { kind: 'VarRef', name: s.name, type: OIR_TYPE[s.wt] }, t: s.wt };
    }
    if (h === 'local.tee') return this.assignLocal(n, ctx);
    if (h === 'local.set') {
      // wasm 的 local.set 不留值；留值的那个叫 local.tee
      this.err(n.span, "'local.set' produces no value; use 'local.tee' if you want the value back");
      return null;
    }
    if (h === 'call') return this.call(n, ctx);
    if (h === 'global.get') {
      const g = this.resolveGlobal(n.items[1]);
      if (g === null) return null;
      return { e: { kind: 'GlobalRef', name: g.name, type: OIR_TYPE[g.wt] }, t: g.wt };
    }
    if (h === 'global.set') {
      this.err(n.span, "'global.set' produces no value");
      return null;
    }
    if (h === 'memory.size') {
      if (this.mem === null) return this.noMem(n, h);
      return { e: { kind: 'MemSize', type: INT }, t: 'i32' };
    }
    if (h === 'memory.grow') {
      if (this.mem === null) return this.noMem(n, h);
      const a = this.operand(n, 1, 'i32', ctx);
      if (a === null) return null;
      return { e: { kind: 'MemGrow', pages: a, type: INT }, t: 'i32' };
    }
    if (MEM_LOAD_OP[h] !== undefined) return this.memLoad(n, h, ctx);
    if (MEM_STORE_OP[h] !== undefined) {
      this.err(n.span, `'${h}' produces no value`);
      return null;
    }
    if (h === 'call_indirect' || h === 'br_table' || h.startsWith('table.')) {
      this.err(n.span, `'${h}' is not supported yet (see the boundary at the top of frontend-wat/lower.js)`);
      return null;
    }
    const dot = h.indexOf('.');
    const prefix = dot < 0 ? h : h.slice(0, dot);
    const opName = dot < 0 ? '' : h.slice(dot + 1);
    if (OIR_TYPE[prefix] === undefined) {
      this.err(n.span, `unknown instruction '${h}'`);
      return null;
    }
    return prefix === 'f64' ? this.f64Op(n, opName, ctx) : this.intOp(n, prefix, opName, ctx);
  }

  /** 把一个值调成想要的 wasm 类型；对不上就报错。 */
  coerce(v, want, span) {
    if (v === null) return zeroValue(OIR_TYPE[want] ?? INT);
    if (v.t === want) return v.e;
    if (v.t === 'bool' && (want === 'i32' || want === 'i64')) {
      // bool -> i32/i64 的 0/1
      return { kind: 'Ternary', cond: v.e, then: iconst(1), otherwise: iconst(0), type: INT };
    }
    this.err(span, `expected ${want}, found ${v.t}`);
    return zeroValue(OIR_TYPE[want] ?? INT);
  }

  /** 当条件用。i32 的"非零即真"在这里变成一次比较，而 bool 直接就是条件。 */
  cond(v, n) {
    if (v === null) return null;
    if (v.t === 'bool') return v.e;
    if (v.t === 'f64') {
      this.err(n.span, 'a condition must be i32 (or a comparison), not f64');
      return null;
    }
    return cmp('!=', INT, v.e, iconst(0));
  }

  /** 局部量：`$name` 或数字下标 */
  localSlot(n, ctx) {
    if (!isAtom(n)) {
      this.err(n === undefined || n === null ? null : n.span, 'expected a local name or index');
      return null;
    }
    if (n.value.startsWith('$')) {
      const i = ctx.byName.get(n.value);
      if (i === undefined) {
        this.err(n.span, `unknown local '${n.value}'`);
        return null;
      }
      return ctx.slots[i];
    }
    const i = Number.parseInt(n.value, 10);
    if (!Number.isInteger(i) || i < 0 || i >= ctx.slots.length) {
      this.err(n.span, `local index ${n.value} is out of range`);
      return null;
    }
    return ctx.slots[i];
  }

  /** `local.set` 与 `local.tee` 是同一个赋值，区别只在有没有值可用 */
  assignLocal(n, ctx) {
    const s = this.localSlot(n.items[1], ctx);
    if (s === null) return null;
    if (n.items[2] === undefined) {
      this.err(n.span, `the folded (${head(n)} LOCAL VALUE) form is required`);
      return null;
    }
    const v = this.coerce(this.value(n.items[2], ctx), s.wt, n.span);
    const t = OIR_TYPE[s.wt];
    return { e: { kind: 'Assign', target: { kind: 'VarRef', name: s.name, type: t }, value: v, type: t }, t: s.wt };
  }

  /** `global.set` 的赋值。不可变的全局写起来要拒 —— 那是 wasm 校验器的规则。 */
  assignGlobal(n, ctx) {
    const g = this.resolveGlobal(n.items[1]);
    if (g === null) return null;
    if (!g.mut) {
      this.err(n.span, `global '${g.wasmName ?? g.name}' is immutable; declare it as (mut ${g.wt}) to assign it`);
      return null;
    }
    if (n.items[2] === undefined) {
      this.err(n.span, 'the folded (global.set GLOBAL VALUE) form is required');
      return null;
    }
    const t = OIR_TYPE[g.wt];
    const v = this.coerce(this.value(n.items[2], ctx), g.wt, n.span);
    return {
      e: { kind: 'Assign', target: { kind: 'GlobalRef', name: g.name, type: t }, value: v, type: t },
      t: g.wt,
    };
  }

  /* ------------------------------------------------ 线性内存（第四刀） */

  noMem(n, h) {
    this.err(n.span, `'${h}' needs a (memory ...) field in the module`);
    return null;
  }

  /**
   * `offset=N` / `align=N` 立即数 —— 紧跟指令名的 atom，在折叠实参之前。
   * `align=` 读了就丢：wasm 里它只是给引擎的优化提示、不改语义，而三套实现都不要求对齐
   * （第二刀的描述符里也刻意没有这一格）。返回第一个折叠实参的下标。
   */
  memImm(n) {
    let k = 1;
    let off = 0;
    let bad = false;
    while (isAtom(n.items[k]) && /^(offset|align)=/.test(n.items[k].value)) {
      const it = n.items[k];
      const eq = it.value.indexOf('=');
      const v = intLit({ kind: 'atom', value: it.value.slice(eq + 1), span: it.span }, 64);
      if (v === null || v < 0n) {
        this.err(it.span, `'${it.value}' needs a non-negative number`);
        bad = true;
      } else if (it.value.slice(0, eq) === 'offset') {
        off = Number(v);
      }
      k++;
    }
    return bad ? null : { k, off };
  }

  /**
   * 地址是 i32，而 wasm **按无符号**读它 —— 这个前端里 i32 的表示是符号扩展的，所以要
   * 零扩展一次，否则 `0x80000000` 那个地址会变成负数（越界消息里印出来的也是负数）。
   * 代价是每次访问多一条 `&`。常量地址在这里就折掉，不留那条与 —— 手写的 wat 里
   * 绝大多数访存的地址都是常量或常量加局部量。
   */
  memAddr(e) {
    if (e.kind === 'Const' && e.value >= 0n && e.value < 0x80000000n) return e;
    return zext32(e);
  }

  memLoad(n, h, ctx) {
    if (this.mem === null) return this.noMem(n, h);
    const imm = this.memImm(n);
    if (imm === null) return null;
    const a = n.items[imm.k];
    if (a === undefined) {
      this.err(n.span, `the folded (${h} ADDR) form is required`);
      return null;
    }
    const rt = h.slice(0, h.indexOf('.'));
    const addr = this.memAddr(this.coerce(this.value(a, ctx), 'i32', a.span));
    return {
      e: { kind: 'MemLoad', mkind: MEM_LOAD_OP[h], addr, off: imm.off, type: OIR_TYPE[rt] },
      t: rt,
    };
  }

  memStore(n, h, ctx, out) {
    if (this.mem === null) { this.noMem(n, h); return; }
    const imm = this.memImm(n);
    if (imm === null) return;
    const a = n.items[imm.k];
    const v = n.items[imm.k + 1];
    if (a === undefined || v === undefined) {
      this.err(n.span, `the folded (${h} ADDR VALUE) form is required`);
      return;
    }
    const vt = h.slice(0, h.indexOf('.'));
    const addr = this.memAddr(this.coerce(this.value(a, ctx), 'i32', a.span));
    const val = this.coerce(this.value(v, ctx), vt, v.span);
    out.push({
      kind: 'ExprStmt',
      expr: {
        kind: 'MemStore', mkind: MEM_STORE_OP[h], addr, off: imm.off, value: val, type: OIR_TYPE[vt],
      },
    });
  }

  call(n, ctx) {
    const d = this.resolveFunc(n.items[1]);
    if (d === null) return null;
    const args = n.items.slice(2);
    if (args.length !== d.params.length) {
      this.err(n.span, `'${d.name ?? d.mangled}' takes ${d.params.length} argument(s), got ${args.length}`);
      return null;
    }
    const lowered = args.map((a, i) => this.coerce(this.value(a, ctx), d.params[i].wt, a.span));
    // 宿主面那几条不是真函数，直接落成内建 —— print 的格式与换行于是和别的前端共用一份
    if (d.host !== null) {
      const spec = HOST_FUNCS[d.host];
      return { e: { kind: 'Builtin', name: 'print', args: lowered, type: VOID, argType: spec.argType }, t: 'void' };
    }
    const t = d.results.length === 0 ? 'void' : d.results[0];
    return { e: { kind: 'Call', func: d.mangled, name: d.name ?? d.mangled, args: lowered, type: d.results.length === 0 ? VOID : OIR_TYPE[t] }, t };
  }

  // ---------------------------------------------------------------- 数值指令

  /** 取第 k 个折叠实参并调成 want 类型 */
  operand(n, k, want, ctx) {
    const a = n.items[k];
    if (a === undefined) {
      this.err(n.span, `'${head(n)}' needs ${k} folded operand(s)`);
      return null;
    }
    return this.coerce(this.value(a, ctx), want, a.span);
  }

  intOp(n, wt, op, ctx) {
    const bits = wt === 'i32' ? 32 : 64;
    if (op === 'const') {
      const v = intLit(n.items[1], bits);
      if (v === null) {
        this.err(n.span, `'${wt}.const' needs an integer literal in range`);
        return null;
      }
      return { e: { kind: 'Const', type: INT, value: v }, t: wt };
    }
    if (op === 'eqz') {
      const a = this.operand(n, 1, wt, ctx);
      return a === null ? null : { e: cmp('==', INT, a, iconst(0)), t: 'bool' };
    }
    // 转换：i32 那一侧的表示不变（一直是符号扩展的），所以只有两条真要动手
    if (wt === 'i32' && op === 'wrap_i64') {
      const a = this.operand(n, 1, 'i64', ctx);
      return a === null ? null : { e: wrap32(a), t: 'i32' };
    }
    if (wt === 'i64' && (op === 'extend_i32_s' || op === 'extend_i32_u')) {
      const a = this.operand(n, 1, 'i32', ctx);
      if (a === null) return null;
      return { e: op === 'extend_i32_s' ? a : zext32(a), t: 'i64' };
    }
    if (op === 'trunc_f64_s') {
      const a = this.operand(n, 1, 'f64', ctx);
      if (a === null) return null;
      const t = { kind: 'Builtin', name: 'trunc', args: [a], type: INT };
      return { e: wt === 'i32' ? wrap32(t) : t, t: wt };
    }
    const sign = op.endsWith('_u') ? 'u' : 's';
    if (sign === 'u' && wt === 'i64') {
      this.err(n.span, `'i64.${op}' is not supported: 64-bit unsigned arithmetic does not fit OIR's int64 (i32's unsigned ops do — they go through zero-extension)`);
      return null;
    }
    const cmpOp = INT_CMP[op];
    if (cmpOp !== undefined) {
      let a = this.operand(n, 1, wt, ctx);
      let b = this.operand(n, 2, wt, ctx);
      if (a === null || b === null) return null;
      if (sign === 'u') { a = zext32(a); b = zext32(b); }
      return { e: cmp(cmpOp, INT, a, b), t: 'bool' };
    }
    const shiftOp = op === 'shl' ? '<<' : op === 'shr_s' || op === 'shr_u' ? '>>' : null;
    if (shiftOp !== null) {
      let a = this.operand(n, 1, wt, ctx);
      const b = this.operand(n, 2, wt, ctx);
      if (a === null || b === null) return null;
      // wasm 的移位量按位宽取模；omni_shl/omni_shr 自己只 &63，所以 i32 这一侧要显式 &31
      const amount = bits === 32 ? ibin('&', b, iconst(31)) : b;
      if (op === 'shr_u') a = zext32(a);
      const e = ibin(shiftOp, a, amount);
      // shr_u 之后要回绕：零扩展把负数变成了大正数，结果得再压回 i32 的表示
      return { e: bits === 32 && op !== 'shr_s' ? wrap32(e) : e, t: wt };
    }
    const binOp = INT_BIN[op];
    if (binOp === undefined) {
      this.err(n.span, `'${wt}.${op}' is not supported yet`);
      return null;
    }
    let a = this.operand(n, 1, wt, ctx);
    let b = this.operand(n, 2, wt, ctx);
    if (a === null || b === null) return null;
    if (sign === 'u') { a = zext32(a); b = zext32(b); }
    const e = ibin(binOp, a, b);
    // 位运算在符号扩展的表示下是封闭的，不用回绕；算术要
    const closed = binOp === '&' || binOp === '|' || binOp === '^';
    return { e: bits === 32 && !closed ? wrap32(e) : e, t: wt };
  }

  f64Op(n, op, ctx) {
    if (op === 'const') {
      const v = floatLit(n.items[1]);
      if (v === null) {
        this.err(n.span, "'f64.const' needs a decimal float, 'inf', '-inf' or 'nan' (hex floats and nan payloads are not supported yet)");
        return null;
      }
      return { e: rconst(v), t: 'f64' };
    }
    if (op === 'neg') {
      const a = this.operand(n, 1, 'f64', ctx);
      return a === null ? null : { e: { kind: 'Un', op: '-', operand: a, type: REAL }, t: 'f64' };
    }
    if (op === 'convert_i32_s' || op === 'convert_i64_s' || op === 'convert_i32_u') {
      const from = op === 'convert_i64_s' ? 'i64' : 'i32';
      const a = this.operand(n, 1, from, ctx);
      if (a === null) return null;
      return { e: { kind: 'Cast', expr: op === 'convert_i32_u' ? zext32(a) : a, from: INT, type: REAL }, t: 'f64' };
    }
    const cmpOp = F64_CMP[op];
    if (cmpOp !== undefined) {
      const a = this.operand(n, 1, 'f64', ctx);
      const b = this.operand(n, 2, 'f64', ctx);
      if (a === null || b === null) return null;
      return { e: cmp(cmpOp, REAL, a, b), t: 'bool' };
    }
    const binOp = F64_BIN[op];
    if (binOp === undefined) {
      this.err(n.span, `'f64.${op}' is not supported yet`);
      return null;
    }
    const a = this.operand(n, 1, 'f64', ctx);
    const b = this.operand(n, 2, 'f64', ctx);
    if (a === null || b === null) return null;
    return { e: rbin(binOp, a, b), t: 'f64' };
  }

  // ---------------------------------------------------------------- 收尾

  /** 第二遍：`(export ...)` 与 `(start ...)`，然后造入口 */
  finish(fields) {
    for (const f of fields) {
      const h = head(f);
      if (h === 'export') {
        const nm = f.items[1];
        const desc = f.items[2];
        if (!isStr(nm)) { this.err(f.span, '(export ...) needs a string name'); continue; }
        if (head(desc) !== 'func') { this.err(f.span, 'only function exports are supported yet'); continue; }
        const d = this.resolveFunc(desc.items[1]);
        if (d !== null) d.exportName = nm.value;
        continue;
      }
      if (h === 'start') this.startRef = f.items[1];
    }

    let entry = null;
    if (this.startRef !== null) entry = this.resolveFunc(this.startRef);
    else {
      for (const d of this.decls) {
        if (d.exportName === 'main') { entry = d; break; }
      }
    }
    const stmts = [];
    // 全局量的初值就是入口最前面的几句赋值（核心方言的 `(global …)` 也是这么做的，
    // 见 sexpr/lower.js）—— 于是六个后端只要会存取一个全局就够，不必各写一份初始化。
    // 顺序是声明序，所以两次降级出来的文本一样。
    for (const g of this.globals) {
      stmts.push({
        kind: 'ExprStmt',
        expr: {
          kind: 'Assign', target: { kind: 'GlobalRef', name: g.name, type: OIR_TYPE[g.wt] },
          value: g.init, type: OIR_TYPE[g.wt],
        },
      });
    }
    if (entry === null) {
      this.err(null, 'no entry point: add (start $f) or export a function as "main"');
    } else if (entry.params.length !== 0) {
      this.err(entry.span, 'the entry function must take no parameters');
    } else if (entry.host !== null) {
      this.err(entry.span, 'the entry function cannot be an import');
    } else {
      const t = entry.results.length === 0 ? VOID : OIR_TYPE[entry.results[0]];
      const call = { kind: 'Call', func: entry.mangled, name: entry.name ?? entry.mangled, args: [], type: t };
      // 入口的返回值没人要 —— wasm 的 start 段本来就是 `[] -> []`，导出的 main 有结果时丢掉
      stmts.push({ kind: 'ExprStmt', expr: call });
    }
    stmts.push({ kind: 'Return', value: null });

    const funcs = [];
    for (const d of this.decls) {
      if (d.host === null && d.func !== undefined) funcs.push(d.func);
    }
    funcs.push({ name: 'main', mangled: 'omni_main', ret: VOID, params: [], body: oirBlock(stmts) });
    return {
      structs: [], classes: [], enums: [], containers: [], closures: [], fnTypes: [],
      funcs,
      globals: this.globals.map((g) => ({ name: g.name, mangled: `g_${g.name}`, type: OIR_TYPE[g.wt] })),
      mem: this.mem,
      entry: 'omni_main',
    };
  }
}

const INT_BIN = { add: '+', sub: '-', mul: '*', div_s: '/', rem_s: '%', div_u: '/', rem_u: '%', and: '&', or: '|', xor: '^' };
const INT_CMP = {
  eq: '==', ne: '!=',
  lt_s: '<', le_s: '<=', gt_s: '>', ge_s: '>=',
  lt_u: '<', le_u: '<=', gt_u: '>', ge_u: '>=',
};
const F64_BIN = { add: '+', sub: '-', mul: '*', div: '/' };
const F64_CMP = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };

/**
 * 整数字面量。WAT 允许十进制与 `0x`，允许下划线分隔，而且**允许把值写成无符号的**
 * （`i32.const 0xffffffff` 就是 -1），所以读完还要按位宽折回有符号区间。
 *
 * 逐位累加而不是先 `BigInt(整串)` 再取模：`0xffffffffffffffff` 这种写法是合法的，
 * 而它的值超出 int64 —— 而 JS 域的 bigint 在原生构建里**就是** int64（ADR-0005）。
 * 每一步都 asIntN 回来，于是中间值永远落在 int64 里，两个宿主上算出的东西也一样。
 */
function intLit(n, bits) {
  if (!isAtom(n)) return null;
  let s = n.value.replace(/_/g, '');
  let neg = false;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  let base = 10n;
  if (/^0[xX]/.test(s)) {
    base = 16n;
    s = s.slice(2);
  }
  if (s.length === 0) return null;
  const ok = base === 16n ? /^[0-9a-fA-F]+$/.test(s) : /^[0-9]+$/.test(s);
  if (!ok) return null;
  let acc = 0n;
  for (let i = 0; i < s.length; i++) {
    const d = BigInt(Number.parseInt(s.slice(i, i + 1), 16));
    acc = BigInt.asIntN(64, acc * base + d);
  }
  if (neg) acc = BigInt.asIntN(64, -acc);
  if (bits === 64) return acc;
  // 折回 32 位有符号。刻意不写 BigInt.asIntN(32, ..)：原生构建的运行时只实现了 64
  // （量出来的 —— 用原生编译器跑 .wat 时当场报错）。这三步全程留在 int64 里。
  let m = acc & 0xffffffffn;
  if (m >= 0x80000000n) m -= 0x100000000n;
  return m;
}

/** 浮点字面量。十六进制浮点与 `nan:0x...` 载荷暂不认 —— 它们的用处只在 spec 测试里。 */
function floatLit(n) {
  if (!isAtom(n)) return null;
  const s = n.value.replace(/_/g, '');
  if (s === 'inf' || s === '+inf') return Infinity;
  if (s === '-inf') return -Infinity;
  if (s === 'nan' || s === '+nan' || s === '-nan') return NaN;
  if (/^[-+]?0[xX]/.test(s)) return null;
  if (!/^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * WAT 源码 -> OIR 模块。
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 */
export function lowerWat(file, diags) {
  const nodes = readSexpr(file, diags);
  return new LowerWat(diags).module(nodes);
}

