/**
 * MIR -> **JS 源码**（ADR-0013「JS 宿主上的高性能解释器就是编成 JS」那一节）。
 *
 * 为什么有这一份：`bench/paths.js` 量出来的三个数是「手写 JS 1.0x / 编成 JS 1.5x /
 * 解释器 10x」。那 10 倍不是 dispatch（量过，特化 dispatch 是 0 收益），是解释器
 * **结构上拿不掉**的两笔成本 —— 值必须装箱进一个统一表示、局部量必须住在数组里。
 * 编成 JS 两笔都没有：槽是真的 `let`，值是真的局部变量，V8 能把它们放进寄存器。
 *
 * 于是 C 在 JS 宿主上的默认执行路径是这一条，`mir/interp.js` 退回 oracle 的身份
 * （它是唯一一条不要 `new Function` 的执行器 —— CSP 禁 eval 的页面只有它）。
 * 这一条同时是**浏览器里跑 C** 的那条路。
 *
 * 三条约定（与 ADR 里那一节逐条对应）：
 *   - **控制流直接落成 JS 的控制流**。MIR 的控制流是结构化的（ADR-0014 决策 6：
 *     `BLOCK`/`LOOP`/`IF`/`ELSE`/`END` + 按层数的 `BR`），所以代码生成是一次
 *     递归下降：`LOOP` -> `L3: while (true) {…}`、`BLOCK` -> `L7: {…}`、
 *     `BR ^n` -> `break L{那一层}` 或 `continue L{那一层}`。
 *     **不需要 relooper、不需要 pc 循环、不需要状态机 switch。**
 *   - **语义不重新实现**：线性内存走 `interp/builtin.js` 的 `memLoadFn`/`memStoreFn`，
 *     libc 走 `interp/libc.js` 的 `callLibc`。字节序、越界消息、`printf` 的格式化
 *     全仓只有一份 —— 这条路与解释器分叉的话，「逐字节相同」那道门就成了摆设。
 *   - **值表示与解释器逐位相同**（这一刀）：整数一律 BigInt、i32 按 32 位回绕。
 *     「i32 换成 Number」值 10 倍（ADR-0013 量过），但它的工作量全在**边界**上
 *     （内存读写、libc、i32<->i64 的每一次转换），所以分成两刀：这一刀先把
 *     「不再有解释循环」这件事拿到手，量一次；下一刀才动表示，再量一次。
 *
 * 发出来的 JS **不是给人读的**（槽是 `s0`、值是 `v12`），也**不是自足的**
 * （要 import 上面那两组运行时）。它的身份是「给 V8 吃的中间产物」。
 */

import { OmniError } from '../source/diag.js';
import {
  OP, OP_NAMES, OP_MODES, REF_NONE, REF_BIAS, isConstRef,
  T_VOID, T_I64, T_F64, T_STR, T_I32, T_F32,
  MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff,
  CVT_I2F, CVT_F2I, CVT_F2U, CVT_BOX, CVT_U2F, CVT_SEXT, CVT_ZEXT, CVT_TRUNC,
  CVT_SEXT8, CVT_SEXT16, CVT_FCVT, CVT_NAMES,
} from './ir.js';

/* `setjmp` 那一族：这条路上**做不到**（它要「同一帧的同一条指令上再回一次」，而发出来的
 * JS 没有 pc 可以回）。所以在这儿明说，让上层退回解释器 —— 不是假装能跑。 */
const SETJMP_NAMES = new Set(['setjmp', '_setjmp', 'sigsetjmp', '__sigsetjmp',
  'longjmp', '_longjmp', 'siglongjmp']);

/** 一个类型码的零值文本（槽的初值；与 interp 的 zeroOfCode 逐条相同）。 */
function zeroText(t) {
  if (t === T_I64 || t === T_I32) return '0n';
  if (t === T_F64 || t === T_F32) return '0';
  if (t === T_STR) return "''";
  return 'null';
}

/** 常量池条目 -> JS 字面量文本。与 interp 的 constVal 一一对应（含 inf/nan 三个）。 */
function constText(c) {
  if (c.kind === 'int') return `${BigInt(c.text)}n`;
  if (c.kind === 'real') {
    if (c.text === 'inf') return 'Infinity';
    if (c.text === '-inf') return '-Infinity';
    if (c.text === 'nan') return 'NaN';
    // 用 JS 自己的往返表示：`1e400` 之类的文本进来也不会变成 `Infinity` 以外的东西
    const n = Number(c.text);
    return Object.is(n, -0) ? '-0' : String(n);
  }
  if (c.kind === 'bool') return c.text === 'true' ? 'true' : 'false';
  if (c.kind === 'str') return JSON.stringify(c.text);
  if (c.kind === 'undef') return 'undefined';
  return 'null';
}

/* 二元运算：op -> [i64 的文本模板, i32 的模板, 浮点的模板]。
 * 模板里 `A`/`B` 是两个操作数。i64 那一列**逐字照抄** `interp/builtin.js` 的
 * `binOp('int', …)`：`>>`、`&`、`|`、`^` 那四条在那一份里就是**不回绕**的
 * （BigInt 的这四个运算在两补语义下不会越出 64 位），照抄比"看起来更对"重要。 */
const BIN = new Map([
  [OP.ADD, ['$W(A + B)', '$W32(A + B)', 'A + B']],
  [OP.SUB, ['$W(A - B)', '$W32(A - B)', 'A - B']],
  [OP.MUL, ['$W(A * B)', '$W32(A * B)', 'A * B']],
  [OP.DIV, ['$idiv(A, B)', '$idiv32(A, B)', 'A / B']],
  [OP.MOD, ['$imod(A, B)', '$imod32(A, B)', 'A % B']],
  [OP.SHL, ['$W(A << (B & 63n))', '$W32(A << (B & 31n))', null]],
  [OP.SHR, ['A >> (B & 63n)', '$W32(A >> (B & 31n))', null]],
  [OP.BAND, ['A & B', '$W32(A & B)', null]],
  [OP.BOR, ['A | B', '$W32(A | B)', null]],
  [OP.BXOR, ['A ^ B', '$W32(A ^ B)', null]],
  [OP.UDIV, ['$udiv(A, B)', '$udiv32(A, B)', null]],
  [OP.UMOD, ['$umod(A, B)', '$umod32(A, B)', null]],
  [OP.USHR, ['$W($U(A) >> (B & 63n))', '$W32($U32(A) >> (B & 31n))', null]],
]);

/** 比较：op -> [有符号的运算符, i32/i64 上要不要先按无符号读]。 */
const CMP = new Map([
  [OP.EQ, ['===', false]], [OP.NE, ['!==', false]],
  [OP.LT, ['<', false]], [OP.LE, ['<=', false]],
  [OP.GT, ['>', false]], [OP.GE, ['>=', false]],
  [OP.ULT, ['<', true]], [OP.ULE, ['<=', true]],
  [OP.UGT, ['>', true]], [OP.UGE, ['>=', true]],
]);

/**
 * 发出来的那一段的**序**（prologue）：几个回绕助手加除法那四条。
 * 除法四条与 `interp/builtin.js` 的 `idiv`/`imod`/`biUdiv`/`umod` 逐条相同，
 * 包括 `INT64_MIN / -1` 那两条边角 —— i32 那三条**没有**这个边角（`bin32` 里就没有，
 * 它靠 `$W32` 回绕），两处的差别是有意的，别"顺手补齐"。
 */
const PROLOGUE = `'use strict';
const { memInit, memData, memSize, memGrow, memLoadFn, memStoreFn,
  callLibc, hasLibc, ExitCall, failRt, flushOut, libcAtExit, setFnPtrCaller } = $rt;
const $W = (x) => BigInt.asIntN(64, x);
const $U = (x) => BigInt.asUintN(64, x);
const $W32 = (x) => BigInt.asIntN(32, x);
const $U32 = (x) => BigInt.asUintN(32, x);
const $INT_MIN = -9223372036854775808n;
const $idiv = (a, b) => {
  if (b === 0n) failRt('division by zero');
  return a === $INT_MIN && b === -1n ? $INT_MIN : $W(a / b);
};
const $imod = (a, b) => {
  if (b === 0n) failRt('division by zero');
  return a === $INT_MIN && b === -1n ? 0n : a % b;
};
const $udiv = (a, b) => { if (b === 0n) failRt('division by zero'); return $W($U(a) / $U(b)); };
const $umod = (a, b) => { if (b === 0n) failRt('division by zero'); return $W($U(a) % $U(b)); };
const $idiv32 = (a, b) => { if (b === 0n) failRt('division by zero'); return $W32(a / b); };
const $imod32 = (a, b) => { if (b === 0n) failRt('division by zero'); return $W32(a % b); };
const $udiv32 = (a, b) => { if (b === 0n) failRt('division by zero'); return $W32($U32(a) / $U32(b)); };
const $umod32 = (a, b) => { if (b === 0n) failRt('division by zero'); return $W32($U32(a) % $U32(b)); };
const $f2i = (d, bits) => {
  const x = Math.trunc(d);
  return Number.isFinite(x) ? BigInt.asIntN(bits, BigInt(x)) : 0n;
};
const $f2u = (d) => {
  const x = Math.trunc(d);
  return Number.isFinite(x) && x >= 0 ? BigInt.asIntN(64, BigInt.asUintN(64, BigInt(x))) : 0n;
};
/* libc 那扇门：错误的收法与 mir/interp.js 的 CCALL 一支逐字相同（\`exit\` 抛的
 * ExitCall 要原样穿过去 —— 它不是"程序错了"，是程序要求的退出码）。 */
const $ccall = (name, args) => {
  try {
    return callLibc(name, args);
  } catch (e) {
    if (e instanceof ExitCall) throw e;
    failRt(name + ': ' + (e instanceof Error ? e.message : String(e)));
  }
  return undefined;
};
`;

class JsFromMir {
  constructor(mir) {
    this.mir = mir;
    this.out = [];
    /** 用到的内存访问器：kind -> 变量名（只发用到的那几个，一个 kind 一次查表）。 */
    this.ldFns = new Map();
    this.stFns = new Map();
  }

  /** 一条 ref 的读文本。常量在**发代码期**就变成字面量，指令引用是一个局部变量。 */
  ref(f, r) {
    if (r === REF_NONE) return 'undefined';
    if (isConstRef(r)) return constText(this.mir.consts.items[r]);
    return `v${r - REF_BIAS}`;
  }

  /** 一条 ref 的类型码（比较与运算要按**操作数**的类型分 i32/i64）。 */
  refType(f, r) {
    if (r === REF_NONE) return T_VOID;
    if (isConstRef(r)) return this.mir.consts.items[r].t;
    return f.t[r - REF_BIAS];
  }

  args(f, pool) {
    return f.argsOf(pool).map((r) => this.ref(f, r));
  }

  ldName(kind) {
    let n = this.ldFns.get(kind);
    if (n === undefined) { n = `$ld_${kind}`; this.ldFns.set(kind, n); }
    return n;
  }

  stName(kind) {
    let n = this.stFns.get(kind);
    if (n === undefined) { n = `$st_${kind}`; this.stFns.set(kind, n); }
    return n;
  }

  /**
   * 哪些指令的值**被别人读**。只给这些发局部变量，其余的只留副作用 ——
   * 一个 500 条指令的函数里被读的通常不到一半，少发一半的 `let` 是白捡的。
   */
  usedRefs(f) {
    const used = new Set();
    const mark = (r) => { if (r !== REF_NONE && !isConstRef(r)) used.add(r - REF_BIAS); };
    for (let i = 0; i < f.count(); i++) {
      const mode = OP_MODES[f.op[i]];
      const vals = [f.a[i], f.b[i], f.aux[i]];
      for (let k = 0; k < 3; k++) {
        if (mode[k] === 'r') mark(vals[k]);
        else if (mode[k] === 'p') for (const r of f.argsOf(vals[k])) mark(r);
      }
    }
    return used;
  }

  /** 一条指令的**值表达式**。控制流那几条不走这儿（见 body）。 */
  expr(f, i) {
    const op = f.op[i];
    const t = f.t[i];
    const x = f.aux[i];
    const A = () => this.ref(f, f.a[i]);
    const B = () => this.ref(f, f.b[i]);
    if (BIN.has(op)) {
      const [i64, i32, flt] = BIN.get(op);
      let tpl = null;
      if (t === T_I64) tpl = i64;
      else if (t === T_I32) tpl = i32;
      else if (t === T_F64 || t === T_F32) tpl = flt;
      else if (t === T_STR && op === OP.ADD) tpl = 'A + B';
      if (tpl === null) this.nyi(f, i, `${OP_NAMES[op]} on ${t}`);
      const e = tpl.replace('A', A()).replace('B', B());
      // f32 的运算要真的舍到单精度（与 interp 的 bin32f 同一句）
      return t === T_F32 ? `Math.fround(${e})` : e;
    }
    if (CMP.has(op)) {
      const [o, uns] = CMP.get(op);
      const ot = this.refType(f, f.a[i]);
      if (uns) {
        const w = ot === T_I32 ? '$U32' : '$U';
        return `${w}(${A()}) ${o} ${w}(${B()})`;
      }
      return `${A()} ${o} ${B()}`;
    }
    switch (op) {
      case OP.LOAD: return `s${x}`;
      case OP.GLOAD: return `$g${x}`;
      case OP.NEG:
        if (t === T_I64) return `$W(-${A()})`;
        if (t === T_I32) return `$W32(-${A()})`;
        if (t === T_F32) return `Math.fround(-${A()})`;
        return `-${A()}`;
      case OP.BNOT: return t === T_I32 ? `$W32(~${A()})` : `$W(~${A()})`;
      case OP.NOT: return `!${A()}`;
      case OP.CVT: return this.cvt(f, i);
      case OP.MSIZE: return 'memSize()';
      case OP.MGROW: return `memGrow(${A()})`;
      case OP.MLOAD:
        return `${this.ldName(MLOAD_KINDS[memKindNo(x)])}(${A()}, ${memOff(x)})`;
      case OP.CALL:
        return `$f${f.a[i]}(${this.args(f, f.b[i]).join(', ')})`;
      case OP.CALLI:
        return `$calli(${A()}, [${this.args(f, f.b[i]).join(', ')}])`;
      case OP.CCALL: {
        const entry = this.mir.cabi[f.a[i]];
        return `$ccall(${JSON.stringify(entry)}, [${this.args(f, f.b[i]).join(', ')}])`;
      }
      default:
        return this.nyi(f, i, OP_NAMES[op]);
    }
  }

  /** CVT 的十三种模式。逐条对着 `mir/interp.js` 的 CVT 一支抄，包括"恒等也要留着"。 */
  cvt(f, i) {
    const t = f.t[i];
    const x = f.aux[i];
    const a = this.ref(f, f.a[i]);
    if (x === CVT_I2F) return t === T_F32 ? `Math.fround(Number(${a}))` : `Number(${a})`;
    if (x === CVT_U2F) {
      const n = `Number($U(${a}))`;
      return t === T_F32 ? `Math.fround(${n})` : n;
    }
    if (x === CVT_F2I) return `$f2i(${a}, ${t === T_I32 ? 32 : 64})`;
    if (x === CVT_F2U) return `$f2u(${a})`;
    // 装箱是恒等（dynamic 就是原生值）；sext 也是（i32 的规范形本来就符号扩展过）
    if (x === CVT_BOX || x === CVT_SEXT) return a;
    if (x === CVT_ZEXT) return `$U32(${a})`;
    if (x === CVT_TRUNC) return `$W32(${a})`;
    if (x === CVT_SEXT8) return `BigInt.asIntN(8, ${a})`;
    if (x === CVT_SEXT16) return `BigInt.asIntN(16, ${a})`;
    if (x === CVT_FCVT) return t === T_F32 ? `Math.fround(${a})` : a;
    return this.nyi(f, i, `cvt ${CVT_NAMES[x] ?? x}`);
  }

  /**
   * 区域配对：每个开区域的指令下标 -> 它的 END / ELSE。与 interp 的 resolveRegions
   * 同一次扫描，但这里只要"配对"，不要 pc —— 跳转靠 JS 的标签。
   */
  regions(f) {
    const endOf = new Array(f.count()).fill(-1);
    const elseOf = new Array(f.count()).fill(-1);
    const stack = [];
    for (let i = 0; i < f.count(); i++) {
      const op = f.op[i];
      if (op === OP.BLOCK || op === OP.LOOP || op === OP.IF) stack.push(i);
      else if (op === OP.ELSE) elseOf[stack[stack.length - 1]] = i;
      else if (op === OP.END) {
        const s = stack.pop();
        if (s === undefined) throw new OmniError(`mir.emit_js: ${f.name} 的 END 比开区域多`);
        endOf[s] = i;
      }
    }
    if (stack.length > 0) throw new OmniError(`mir.emit_js: ${f.name} 的区域不配对`);
    return { endOf, elseOf };
  }

  /**
   * `BR ^n` 落成什么：往外数第 n 层是 LOOP 就是 `continue`（回循环头），
   * 是 BLOCK/IF 就是 `break`（跳到它的 END 之后）—— 与 wasm 的层数语义一样，
   * 也与 interp 那两行（`f.op[start] === OP.LOOP ? start + 1 : endOf[start] + 1`）等价。
   */
  jump(f, stack, lv) {
    const s = stack[stack.length - 1 - lv];
    if (s === undefined) throw new OmniError(`mir.emit_js: ${f.name} 的 BR 跳出了函数`);
    return `${f.op[s] === OP.LOOP ? 'continue' : 'break'} L${s};`;
  }

  func(no) {
    const f = this.mir.funcs[no];
    const { endOf, elseOf } = this.regions(f);
    const used = this.usedRefs(f);
    const L = [];
    /* 形参就是前几个槽（降级器是这么分的）。缺席的实参在 interp 里补零值，
     * 这里用 JS 的默认参数 —— 同一个意思，而且热路径上不多一次判断。 */
    const ps = f.params.map((p, k) => `s${k} = ${zeroText(p.t)}`);
    L.push(`function $f${no}(${ps.join(', ')}) {`);
    for (let k = f.params.length; k < f.slots.length; k++) {
      L.push(`  let s${k} = ${zeroText(f.slots[k].t)};`);
    }
    const vs = [];
    for (const i of used) vs.push(`v${i}`);
    if (vs.length > 0) L.push(`  let ${vs.join(', ')};`);

    const stack = [];
    let ind = '  ';
    const push = (s) => L.push(ind + s);
    for (let i = 0; i < f.count(); i++) {
      const op = f.op[i];
      const x = f.aux[i];
      if (op === OP.BLOCK) { push(`L${i}: {`); stack.push(i); ind += '  '; continue; }
      if (op === OP.LOOP) { push(`L${i}: while (true) {`); stack.push(i); ind += '  '; continue; }
      if (op === OP.IF) {
        push(`L${i}: if (${this.ref(f, f.a[i])} === true) {`);
        stack.push(i);
        ind += '  ';
        continue;
      }
      if (op === OP.ELSE) { ind = ind.slice(2); push('} else {'); ind += '  '; continue; }
      if (op === OP.END) {
        const s = stack.pop();
        ind = ind.slice(2);
        /* LOOP 落到底是**退出**循环（wasm 的 loop 不自动回头），所以补一条 break。
         * 少这一句就是死循环 —— 而它只在"真的能落到底"时才发得出来（不可达的话
         * V8 也不在意，那一句就是死代码）。 */
        if (f.op[s] === OP.LOOP) push(`  break L${s};`);
        push('}');
        continue;
      }
      if (op === OP.BR) { push(this.jump(f, stack, x)); continue; }
      if (op === OP.BRIF) {
        push(`if (${this.ref(f, f.a[i])} === true) ${this.jump(f, stack, x)}`);
        continue;
      }
      if (op === OP.BRTABLE) {
        /* 跳表。`Number(下标)` 之后负数与超界都落到 default —— 与 interp 那句
         * 「按无符号读，越界走兜底」等价（表长不会大到 2^31）。 */
        const levels = f.levelsOf(f.b[i]);
        push(`switch (Number(${this.ref(f, f.a[i])})) {`);
        for (let k = 0; k < levels.length; k++) push(`  case ${k}: ${this.jump(f, stack, levels[k])}`);
        push(`  default: ${this.jump(f, stack, x)}`);
        push('}');
        continue;
      }
      if (op === OP.RET) {
        push(f.a[i] === REF_NONE ? 'return;' : `return ${this.ref(f, f.a[i])};`);
        continue;
      }
      if (op === OP.STORE) { push(`s${x} = ${this.ref(f, f.a[i])};`); continue; }
      if (op === OP.GSTORE) { push(`$g${x} = ${this.ref(f, f.a[i])};`); continue; }
      if (op === OP.MSTORE) {
        /* 值也是这条指令的结果（interp 一样），所以被人读时把赋值嵌在实参里 ——
         * 两个操作数都是已经算好的局部量，求值次序无关。 */
        const st = this.stName(MSTORE_KINDS[memKindNo(x)]);
        const v = used.has(i) ? `v${i} = ${this.ref(f, f.b[i])}` : this.ref(f, f.b[i]);
        push(`${st}(${this.ref(f, f.a[i])}, ${memOff(x)}, ${v});`);
        continue;
      }
      const e = this.expr(f, i);
      if (used.has(i)) push(`v${i} = ${e};`);
      else if (f.t[i] === T_VOID || this.effectful(f.op[i])) push(`${e};`);
      // 没人读、又没有副作用的纯运算：整条丢掉（降级器留下的死值不少）
    }
    L.push('}');
    return L;
  }

  /** 有副作用的 op：没人读它的值也得发出来。 */
  effectful(op) {
    return op === OP.CALL || op === OP.CALLI || op === OP.CCALL
      || op === OP.MSTORE || op === OP.MGROW;
  }

  nyi(f, i, what) {
    throw new OmniError(`mir.emit_js: ${f.name} 里还发不出 ${what}`);
  }

  emit() {
    const mir = this.mir;
    for (const e of mir.cabi) {
      if (SETJMP_NAMES.has(e)) {
        throw new OmniError(`mir.emit_js: 这条路发不出 ${e}（它要回到同一帧的同一条指令，`
          + '发出来的 JS 没有那个 pc）—— 用 --backend interp');
      }
    }
    const L = [PROLOGUE];
    for (let i = 0; i < mir.globals.length; i++) L.push(`let $g${i} = undefined;`);
    const bodies = [];
    for (let no = 0; no < mir.funcs.length; no++) bodies.push(...this.func(no));
    // 访问器在函数体发完之后才知道用了哪几个，但声明要在前面 —— 所以这里才拼
    for (const [kind, name] of this.ldFns) L.push(`const ${name} = memLoadFn(${JSON.stringify(kind)});`);
    for (const [kind, name] of this.stFns) L.push(`const ${name} = memStoreFn(${JSON.stringify(kind)});`);
    L.push(...bodies);
    // 函数表：CALLI（C 的函数指针）与 libc 回调（qsort 的比较器）都按它查
    const table = mir.funcs.map((f, no) => `$f${no}`).join(', ');
    L.push(`const $FN = [${table}];`);
    L.push(`const $calli = (fp, args) => {
  const no = Number(fp) - 1;
  if (no < 0) failRt('call of a null function pointer');
  if ($FN[no] === undefined) failRt('function pointer index ' + no + ' out of range');
  return $FN[no](...args);
};`);
    L.push(...this.runner());
    return L.join('\n') + '\n';
  }

  /**
   * `$run()`：与 `runMirModule` 同一套收摊 —— 内存先就位、`exit` 的退出码原样带出、
   * 从 `main` 返回等价于 `exit`（C11 5.1.2.2.3，所以要 `libcAtExit` + `flushOut`）。
   * 退出码只留低 8 位（wait(2) 只传得下一个字节，`return -1` 于是是 255）。
   */
  runner() {
    const mir = this.mir;
    const no = mir.funcIndex.get(mir.entry);
    if (no === undefined) throw new OmniError(`mir.emit_js: no entry function '${mir.entry}'`);
    const L = ['function $run() {'];
    if (mir.mem !== null) {
      L.push(`  memInit(${mir.mem.min}, ${mir.mem.max});`);
      /* data 段就是一串数字字面量。不走 base64/`Buffer`：**这一份自己也要能被 omni
       * 编译**（自举那条门），而 `Buffer` 不在封闭子集里。代价只是源码大一点，
       * 而 data 段只在装载时走一次。 */
      for (const d of mir.mem.data) {
        L.push(`  memData(${d.off}, [${d.bytes.join(',')}]);`);
      }
    }
    L.push(`  setFnPtrCaller((ptr, args) => $calli(ptr, args));`);
    L.push('  let code = 0;');
    L.push('  try {');
    L.push(`    const r = $f${no}();`);
    const ret = mir.funcs[no].ret;
    if (ret === T_VOID) L.push('    code = 0;');
    else L.push('    code = r === undefined || r === null ? 0 : Number(BigInt.asUintN(8, BigInt(r)));');
    L.push('  } catch (e) {');
    L.push('    if (e instanceof ExitCall) { libcAtExit(); flushOut(); return e.code; }');
    L.push('    throw e;');
    L.push('  }');
    L.push('  libcAtExit();');
    L.push('  flushOut();');
    L.push('  return code;');
    L.push('}');
    return L;
  }
}

/**
 * 一份 MIR -> 一段 JS 源码。回来的文本是一个**函数体**，它要一个名叫 `$rt` 的参数
 * （运行时那一组，见 `mir/js_rt.js`），里面定义 `$run()`。
 *
 * 两个消费者，都在这一份文本上：
 *   - 在本进程里跑：`new Function('$rt', src + 'return $run;')(RT)()`
 *   - 出一个文件：`opts.rtImport` 给运行时模块的 specifier，那时文本自带
 *     `import` 与末尾的 `process.exit($run())`，`node x.js` 直接能跑。
 */
export function emitMirJs(mir, opts) {
  const src = new JsFromMir(mir).emit();
  const spec = opts === undefined ? undefined : opts.rtImport;
  if (spec === undefined) return src;
  return `import { RT as $rt } from ${JSON.stringify(spec)};\n${src}\nprocess.exit($run());\n`;
}
