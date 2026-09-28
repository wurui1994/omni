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
 *   - **值表示按 MIR 的类型码分**（ADR-0013 的第二刀）：**i32/f32/f64/bool 是 JS 的
 *     原生值**（i32 的回绕就是 `| 0`、无符号是 `>>> 0`、32 位乘法是 `Math.imul`），
 *     **i64 仍是 BigInt**（number 装不下 64 位，而 C 的 `long long` 必须逐位对）。
 *     这就是解释器那一刀想拿的 10 倍：`(a + b) | 0` 不分配，`$W32(a + b)` 每次分配一个 BigInt。
 *     换的代价全在**边界**上，而边界是可枚举的：内存读写（`memLoadFnN` 那一组）、
 *     libc（那一份收发一律 BigInt，所以门口装一次卸一次）、`CVT` 的每一条、
 *     以及 libc 回调那扇门（`$callFromLibc` 按签名换口径）。
 *
 * 发出来的 JS **不是给人读的**（槽是 `s0`、值是 `v12`），也**不是自足的**
 * （要 import 上面那两组运行时）。它的身份是「给 V8 吃的中间产物」。
 */

import { OmniError } from '../source/diag.js';
import {
  OP, OP_NAMES, OP_MODES, REF_NONE, REF_BIAS, isConstRef,
  T_VOID, T_I64, T_F64, T_STR, T_I32, T_F32,
  MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff, MEM_PAGE,
  CVT_I2F, CVT_F2I, CVT_F2U, CVT_BOX, CVT_U2F, CVT_SEXT, CVT_ZEXT, CVT_TRUNC,
  CVT_SEXT8, CVT_SEXT16, CVT_FCVT, CVT_NAMES,
} from './ir.js';

/**
 * `setjmp` / `longjmp` 那一族的名字。
 *
 * **这两个不是 libc 里的普通调用**：`setjmp` 要「返回两次」。从前这条腿撞上就抛
 * （`JS_NOJMP`），理由写的是"发出来的 JS 没有 pc 可以回"。那句话只对了一半 ——
 * 回不去一条**指令**是真的，但这一份发代码器的形状让"回到某一条指令**之后**"变得可表达：
 *
 *   1. 槽（`s0`…）与 SSA 值（`v0`…）全是**函数作用域**的 `let` —— 所以"帧"在
 *      longjmp 之后原样在那儿，不需要保存/恢复任何东西；
 *   2. 函数体是**结构化**的（BLOCK/LOOP/IF 落成带标签的 JS 块）—— 所以从函数开头
 *      **重新走一遍、把沿路的语句跳过去**，就能落到任意一条指令上。
 *
 * 于是做法是（`sjPlan` 算路、`func` 发码）：
 *   - 带 `setjmp` 的函数整个身子套一层 `$RETRY: for(;;) { try { … } catch { … } }`；
 *   - `$rs`（resume site）是"这一趟要回到哪条指令"：0 = 正常从头跑；
 *   - 每一段**不在路上**的语句裹一层 `if ($rs === 0) { … }` —— 导航时跳过去；
 *   - 路上的区域照原样开（IF 的条件换成"$rs 指着我这一支吗"）；
 *   - 到了那条 `setjmp` 调用点就把 `$rs` 清零，后面的代码照常跑。
 *
 * "跳过去"这件事与 `mir/interp.js` 的语义**一致**：那条腿也不恢复槽，落回去时帧里
 * 是当时的值（C11 7.13.2.1 只保证 `volatile` 的自动变量，别的是未定义行为）。
 * 两条腿在这一点上一样，`tests/c/run.js` 的"JS 腿 == 解释腿"才站得住。
 *
 * R 的错误机制整个建在这一对上（`errors.c` 的 `R_ToplevelExec`、`context.c` 的
 * `RCNTXT` + `R_jumpctxt`），所以这一格是 R 的 C 核心上 JS 腿的**必经之路**（ADR-0047）。
 */
const SETJMP_NAMES = new Set(['setjmp', '_setjmp', 'sigsetjmp', '__sigsetjmp']);
const LONGJMP_NAMES = new Set(['longjmp', '_longjmp', 'siglongjmp']);

/** 一个类型码的零值文本（槽的初值；i32 是 **number** 那一格，见文件头第三条约定）。 */
function jsZeroText(t) {
  if (t === T_I64) return '0n';
  if (t === T_I32) return '0';
  if (t === T_F64 || t === T_F32) return '0';
  if (t === T_STR) return "''";
  return 'null';
}

/** 常量池条目 -> JS 字面量文本。i64 是 BigInt 字面量，**i32 是普通数**。 */
function jsConstText(c) {
  if (c.kind === 'int') {
    return c.t === T_I32 ? String(BigInt.asIntN(32, BigInt(c.text))) : `${BigInt(c.text)}n`;
  }
  if (c.kind === 'real') {
    if (c.text === 'inf') return 'Infinity';
    if (c.text === '-inf') return '-Infinity';
    if (c.text === 'nan') return 'NaN';
    // 用 JS 自己的往返表示：`1e400` 之类的文本进来也不会变成 `Infinity` 以外的东西
    const n = Number(c.text);
    // 负零要发成 `-0`（`String(-0)` 是 "0"，那会把符号丢掉）。判据用 `1/n < 0` 而不是
    // `Object.is(n, -0)`：后者不在封闭 ABI 里（ADR-0011 决策 2），而这两个式子等价。
    return n === 0 && 1 / n < 0 ? '-0' : String(n);
  }
  if (c.kind === 'bool') return c.text === 'true' ? 'true' : 'false';
  if (c.kind === 'str') return JSON.stringify(c.text);
  if (c.kind === 'undef') return 'undefined';
  return 'null';
}

/* 二元运算：op -> [i64 的文本模板, i32 的模板, 浮点的模板]。
 * 模板里 `A`/`B` 是两个操作数。
 *
 * i64 那一列**逐字照抄** `interp/builtin.js` 的 `binOp('int', …)`：`>>`、`&`、`|`、`^`
 * 那四条在那一份里就是**不回绕**的（BigInt 的这四个运算在两补语义下不会越出 64 位），
 * 照抄比"看起来更对"重要。
 *
 * i32 那一列是**JS 的 32 位整数运算**（ADR-0013 那一刀）：`| 0` 就是 `asIntN(32)`，
 * `>>> 0` 就是 `asUintN(32)`，而 `Math.imul` 是唯一能给出正确 32 位乘法的那一条
 * （`a * b` 在超过 2^53 时先丢精度，再 `| 0` 就已经错了 —— 这一格是这一刀里最容易
 * 静默错答案的地方）。移位的计数掩码 31 与 wasm/`bin32` 相同。
 */
const JS_BIN = new Map([
  [OP.ADD, ['$W(A + B)', '(A + B) | 0', 'A + B']],
  [OP.SUB, ['$W(A - B)', '(A - B) | 0', 'A - B']],
  [OP.MUL, ['$W(A * B)', 'Math.imul(A, B)', 'A * B']],
  [OP.DIV, ['$idiv(A, B)', '$idiv32(A, B)', 'A / B']],
  [OP.MOD, ['$imod(A, B)', '$imod32(A, B)', 'A % B']],
  [OP.SHL, ['$W(A << (B & 63n))', 'A << (B & 31)', null]],
  [OP.SHR, ['A >> (B & 63n)', 'A >> (B & 31)', null]],
  [OP.BAND, ['A & B', 'A & B', null]],
  [OP.BOR, ['A | B', 'A | B', null]],
  [OP.BXOR, ['A ^ B', 'A ^ B', null]],
  [OP.UDIV, ['$udiv(A, B)', '$udiv32(A, B)', null]],
  [OP.UMOD, ['$umod(A, B)', '$umod32(A, B)', null]],
  [OP.USHR, ['$W($U(A) >> (B & 63n))', '(A >>> (B & 31)) | 0', null]],
]);

/** 比较：op -> [有符号的运算符, i32/i64 上要不要先按无符号读]。 */
const JS_CMP = new Map([
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
const JS_PROLOGUE = `'use strict';
const { memInit, memData, memAlloc, memPut, memHeap, memSize, memGrow,
  memLoadFn, memStoreFn, memLoadFnN, memStoreFnN,
  fnSlot, fnBind, fnCall, fnCallLibc,
  callLibc, hasLibc, isExitCall, failRt, flushOut, libcAtExit, setFnPtrCaller,
  sjTok, sjSet, sjThrow, sjCatch } = $rt;
const $W = (x) => BigInt.asIntN(64, x);
const $U = (x) => BigInt.asUintN(64, x);
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
/* i32 那四条：\`| 0\` 同时管**截尾**与**回绕** —— \`(-2147483648 / -1) | 0\` 回
 * \`-2147483648\`，与 \`bin32\` 的 \`W32(a / b)\` 一样（i32 这一格**没有** i64 那个
 * INT_MIN/-1 的特例，是有意的，见 mir/interp.js 的注释）。 */
const $idiv32 = (a, b) => { if (b === 0) failRt('division by zero'); return (a / b) | 0; };
const $imod32 = (a, b) => { if (b === 0) failRt('division by zero'); return (a % b) | 0; };
const $udiv32 = (a, b) => { if (b === 0) failRt('division by zero'); return ((a >>> 0) / (b >>> 0)) | 0; };
const $umod32 = (a, b) => { if (b === 0) failRt('division by zero'); return ((a >>> 0) % (b >>> 0)) | 0; };
const $f2i = (d, bits) => {
  const x = Math.trunc(d);
  return Number.isFinite(x) ? BigInt.asIntN(bits, BigInt(x)) : 0n;
};
/* 浮点 -> i32。\`| 0\` 就是 ToInt32，也就是 \`asIntN(32)\`（都是对 2^32 取模再看符号），
 * 所以这一条与解释器那一支同值；装不下与 NaN 收成 0（C 的 UB，两条腿同一个立场）。 */
const $f2i32 = (d) => {
  const x = Math.trunc(d);
  return Number.isFinite(x) ? x | 0 : 0;
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
    if (isExitCall(e)) throw e;
    failRt(name + ': ' + (e instanceof Error ? e.message : String(e)));
  }
  return undefined;
};
`;

/* 哪几种访问有 **number 口径**（`interp/builtin.js` 的 `memLoadFnN`/`memStoreFnN`）：
 * 32 位及以下的整数。i64 装不进 number，f32/f64 本来就是 number（走原来那张表）。
 * 这两个集合与那一份里的两张表**必须同进同出** —— 多列一个名字，运行期就是 `null` 调用。 */
const JS_NUM_LD = new Set(['i8s', 'i8u', 'i16s', 'i16u', 'i32s', 'i32u']);
const JS_NUM_ST = new Set(['i8', 'i16', 'i32']);

class JsFromMir {
  constructor(mir, modular, syms) {
    this.mir = mir;
    /** module 档：地址不烤死，落成"模块基址 + 偏移"（见 `emitMirJs` 头注）。 */
    this.modular = modular === true;
    /** module 档里用到的地址常量：常量池下标 -> 顶层那条 `const $k<下标>`。 */
    this.addrRefs = new Set();
    /** module 档里用到的**函数**地址常量：常量池下标 -> 顶层那条 `const $fp<下标>`。 */
    this.fnRefs = new Set();
    /**
     * **别的模块提供的符号** name -> 那个模块的 specifier（`opts.symbols`）。
     * 函数与数据同一张表 —— C 的符号表就是一张（`add` 与 `R_NilValue` 没有区别）。
     */
    this.syms = syms === undefined || syms === null ? new Map() : syms;
    /** 常量池下标 -> 那条"其实是外部数据符号的地址"（`{name, add}`）。 */
    this.extRef = new Map();
    for (const r of this.mir.dataRefs === undefined ? [] : this.mir.dataRefs) {
      if (this.syms.has(r.name)) this.extRef.set(r.ref, { name: r.name, add: r.add === undefined ? 0 : r.add });
    }
    /** specifier -> 这一句 import 里的那几格（`$fn_x as $f3` / `$sym_y`）。 */
    this.imports = new Map();
    this.out = [];
    /** 用到的内存访问器：kind -> 变量名（只发用到的那几个，一个 kind 一次查表）。 */
    this.ldFns = new Map();
    this.stFns = new Map();
    /** number 口径的那一组（i32 走这边）。 */
    this.ldFnsN = new Map();
    this.stFnsN = new Map();
  }

  /** 记一格 import（按 specifier 归拢，一个 specifier 一句）。 */
  needImport(spec, item) {
    let l = this.imports.get(spec);
    if (l === undefined) { l = []; this.imports.set(spec, l); }
    if (!l.includes(item)) l.push(item);
  }

  /** 一条 ref 的读文本。常量在**发代码期**就变成字面量，指令引用是一个局部变量。 */
  ref(f, r) {
    if (r === REF_NONE) return 'undefined';
    if (isConstRef(r)) {
      if (this.modular) {
        /* 这一条其实是**别人**那个全局量的地址：发成 `import` 进来的那一格。
           活绑定，所以有环也不怕 —— 用它的时候（函数体里）所有模块都装载完了。 */
        const ext = this.extRef.get(r);
        if (ext !== undefined) {
          this.needImport(this.syms.get(ext.name), `$sym_${ext.name}`);
          return ext.add === 0 ? `$sym_${ext.name}` : `($sym_${ext.name} + ${ext.add}n)`;
        }
        /* 自己这张像里的地址：顶层算出来的 `$k<下标>`（= 基址 + 偏移）。
           哪几条是地址由前端记的 `addrConsts` 说 —— 漏一条就是静默错地址。 */
        if (this.mir.addrConsts.has(r)) {
          this.addrRefs.add(r);
          return `$k${r}`;
        }
        /* 这一条其实是**函数**的地址（第一百五十二片）：模块档里函数指针的值是
           全程序那张表的槽位，顶层现要一格（`$fp<下标>`）。本地函数号在模块之间
           互不认识，不换就是静默调错函数。 */
        const fno = this.mir.funcRefs === undefined ? undefined : this.mir.funcRefs.get(r);
        if (fno !== undefined) {
          this.fnRefs.add(r);
          return `$fp${r}`;
        }
      }
      return jsConstText(this.mir.consts.items[r]);
    }
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

  /**
   * 内存访问器的名字。**按值类型选口径**：结果/值是 i32 就用 number 那一组
   * （`memLoadFnN`，读出来直接是 number），别的仍旧用 BigInt 那一组。
   * 选口径这件事在**发代码期**做完，运行期只是一次函数调用。
   */
  ldName(kind, t) {
    if (t === T_I32 && JS_NUM_LD.has(kind)) {
      let n = this.ldFnsN.get(kind);
      if (n === undefined) { n = `$ldn_${kind}`; this.ldFnsN.set(kind, n); }
      return n;
    }
    let n = this.ldFns.get(kind);
    if (n === undefined) { n = `$ld_${kind}`; this.ldFns.set(kind, n); }
    return n;
  }

  stName(kind, t) {
    if (t === T_I32 && JS_NUM_ST.has(kind)) {
      let n = this.stFnsN.get(kind);
      if (n === undefined) { n = `$stn_${kind}`; this.stFnsN.set(kind, n); }
      return n;
    }
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
    if (JS_BIN.has(op)) {
      const [i64, i32, flt] = JS_BIN.get(op);
      let tpl = null;
      if (t === T_I64) tpl = i64;
      else if (t === T_I32) tpl = i32;
      else if (t === T_F64 || t === T_F32) tpl = flt;
      else if (t === T_STR && op === OP.ADD) tpl = 'A + B';
      if (tpl === null) this.nyi(f, i, `${OP_NAMES[op]} on ${t}`);
      /* 一次扫完，别用两次 `replace`：填进去的操作数文本可能自己含 'B'
       * （字符串常量就会），两次 replace 会去改刚填进去的那一段。 */
      const av = A();
      const bv = B();
      const e = tpl.replace(/[AB]/g, (m) => (m === 'A' ? av : bv));
      // f32 的运算要真的舍到单精度（与 interp 的 bin32f 同一句）
      return t === T_F32 ? `Math.fround(${e})` : e;
    }
    if (JS_CMP.has(op)) {
      const [o, uns] = JS_CMP.get(op);
      const ot = this.refType(f, f.a[i]);
      if (uns) {
        // i32 的无符号：`>>> 0` 就是 asUintN(32)；i64 那半边仍旧走 BigInt 的 $U
        if (ot === T_I32) return `(${A()} >>> 0) ${o} (${B()} >>> 0)`;
        return `$U(${A()}) ${o} $U(${B()})`;
      }
      return `${A()} ${o} ${B()}`;
    }
    switch (op) {
      case OP.LOAD: return `s${x}`;
      case OP.GLOAD: return `$g${x}`;
      case OP.NEG:
        if (t === T_I64) return `$W(-${A()})`;
        if (t === T_I32) return `(-${A()}) | 0`;
        if (t === T_F32) return `Math.fround(-${A()})`;
        return `-${A()}`;
      case OP.BNOT: return t === T_I32 ? `~${A()}` : `$W(~${A()})`;
      case OP.NOT: return `!${A()}`;
      case OP.CVT: return this.cvt(f, i);
      case OP.MSIZE: return 'memSize()';
      case OP.MGROW: return `memGrow(${A()})`;
      case OP.MLOAD:
        return `${this.ldName(MLOAD_KINDS[memKindNo(x)], t)}(${A()}, ${memOff(x)})`;
      case OP.CALL:
        return `$f${f.a[i]}(${this.args(f, f.b[i]).join(', ')})`;
      case OP.CALLI:
        return `$calli(${A()}, [${this.args(f, f.b[i]).join(', ')}])`;
      case OP.CCALL: {
        /* libc 那一份收发的整数**一律 BigInt**（它是给解释器写的，而那条腿只有一格整数），
         * 所以 i32 的实参在门口装一次、回值在门口卸一次。这两次换算留在这里不上推：
         * 「语义只有一份」比「少一次 BigInt」重要，而 libc 调用不在内层循环里。 */
        const entry = this.mir.cabi[f.a[i]];
        /* `setjmp` / `longjmp` 的**桩体**：调用点已经在 `func` 里改写过了，所以这儿
         * 只会在"有人拿函数指针去调这个桩"时走到 —— 那一格明说不支持，不静默回 0。 */
        if (SETJMP_NAMES.has(entry) || LONGJMP_NAMES.has(entry)) {
          return `failRt(${JSON.stringify(`${entry}: 只能在直接调用点上发（函数指针绕不过去）`)})`;
        }
        const as = f.argsOf(f.b[i]).map((r) => (this.refType(f, r) === T_I32
          ? `BigInt(${this.ref(f, r)})` : this.ref(f, r)));
        const call = `$ccall(${JSON.stringify(entry)}, [${as.join(', ')}])`;
        return t === T_I32 ? `Number(${call}) | 0` : call;
      }
      default:
        return this.nyi(f, i, OP_NAMES[op]);
    }
  }

  /**
   * CVT 的十三种模式。逐条对着 `mir/interp.js` 的 CVT 一支抄，包括"恒等也要留着"——
   * 唯一的差别是 i32 这一侧是 number，所以整数之间那几条落成的是位运算而不是 BigInt 调用。
   * **方向由「源类型 + 结果类型」两头定**：`I2F` 从 i32 来时源已经是 number（不用 `Number()`），
   * 从 i64 来才要卸一次箱 —— 这一格看错就是一个静默的 `NaN`。
   */
  cvt(f, i) {
    const t = f.t[i];
    const x = f.aux[i];
    const a = this.ref(f, f.a[i]);
    const st = this.refType(f, f.a[i]);
    if (x === CVT_I2F) {
      const n = st === T_I32 ? a : `Number(${a})`;
      return t === T_F32 ? `Math.fround(${n})` : n;
    }
    if (x === CVT_U2F) {
      // 无符号读：i32 是 `>>> 0`，i64 要走 BigInt 的 asUintN 再落回 number
      const n = st === T_I32 ? `(${a} >>> 0)` : `Number($U(${a}))`;
      return t === T_F32 ? `Math.fround(${n})` : n;
    }
    if (x === CVT_F2I) return t === T_I32 ? `$f2i32(${a})` : `$f2i(${a}, 64)`;
    // 浮点 -> 无符号整数：位模式存成两补（解释器那一支就是 64 位的），i32 那格再窄一次
    if (x === CVT_F2U) return t === T_I32 ? `Number($f2u(${a})) | 0` : `$f2u(${a})`;
    // 装箱是恒等（dynamic 就是原生值）
    if (x === CVT_BOX) return a;
    // 扩宽：i32(number) -> i64(BigInt) 要真的装箱；两边都是 i64 时是恒等
    if (x === CVT_SEXT) return st === T_I32 && t === T_I64 ? `BigInt(${a})` : a;
    if (x === CVT_ZEXT) return st === T_I32 ? `BigInt(${a} >>> 0)` : `$U(${a})`;
    // 变窄：i64(BigInt) -> i32(number)
    if (x === CVT_TRUNC) return `Number(BigInt.asIntN(32, ${a}))`;
    // 低 8/16 位的符号扩展。i32 上是两次移位（C 的 `(signed char)x`），i64 上仍是 BigInt
    if (x === CVT_SEXT8) return t === T_I32 ? `(${a} << 24) >> 24` : `BigInt.asIntN(8, ${a})`;
    if (x === CVT_SEXT16) return t === T_I32 ? `(${a} << 16) >> 16` : `BigInt.asIntN(16, ${a})`;
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

  /**
   * 哪几个 MIR 函数是 `setjmp` / `longjmp` 的**桩**。
   *
   * C 前端给每个外部符号发一个桩函数（体里就一条 CCALL），调用点是对桩的 `CALL` ——
   * 所以"要回到的那条指令"是**调用方**的那条 CALL，不是桩里的 CCALL。按桩里那条 CCALL
   * 的入口名认，而不是按函数名认：名字可以被 `#define` 改（`__sigsetjmp`），入口名不会。
   */
  sjStubs() {
    const m = new Map();
    for (let no = 0; no < this.mir.funcs.length; no++) {
      const f = this.mir.funcs[no];
      for (let i = 0; i < f.count(); i++) {
        if (f.op[i] !== OP.CCALL) continue;
        const e = this.mir.cabi[f.a[i]];
        if (SETJMP_NAMES.has(e)) m.set(no, 'setjmp');
        else if (LONGJMP_NAMES.has(e)) m.set(no, 'longjmp');
      }
    }
    return m;
  }

  /**
   * 一个函数里的 `setjmp` 落点，以及"从函数开头走到它"要经过哪些区域。
   *
   * 回 null = 这个函数里没有 `setjmp`，那就一个 `try` 都不多发（既有的那几条轴
   * 一个字节都不该变）。
   *
   * `pathIdx` 是**路上的那些指令下标**：落点自己，加上每一层包着它的区域的
   * 开头 / `ELSE` / `END`（这三样是 JS 的块结构，必须照原样发出来）。
   * `thenSites` 记的是"这个 IF 的 **then** 一支底下有哪些落点" —— 导航的时候
   * IF 的条件要换成"$rs 指着我这一支吗"，而不是原来那个条件。
   */
  sjPlan(f, endOf, elseOf) {
    const isSite = (i) => f.op[i] === OP.CALL && this.sjStub.get(f.a[i]) === 'setjmp';
    const sites = [];
    const pathIdx = new Set();
    const thenSites = new Map();
    const stack = [];
    for (let i = 0; i < f.count(); i++) {
      const op = f.op[i];
      if (op === OP.BLOCK || op === OP.LOOP || op === OP.IF) stack.push(i);
      else if (op === OP.END) stack.pop();
      if (!isSite(i)) continue;
      sites.push(i);
      pathIdx.add(i);
      for (const r of stack) {
        pathIdx.add(r);
        if (elseOf[r] >= 0) pathIdx.add(elseOf[r]);
        pathIdx.add(endOf[r]);
        /* IF：落点在 then 那一支还是 else 那一支，看它在 `ELSE` 之前还是之后。 */
        if (f.op[r] === OP.IF && (elseOf[r] < 0 || i < elseOf[r])) {
          if (!thenSites.has(r)) thenSites.set(r, []);
          thenSites.get(r).push(i);
        }
      }
    }
    if (sites.length === 0) return null;
    return { sites, pathIdx, thenSites, maxSite: sites[sites.length - 1] };
  }

  func(no) {
    const f = this.mir.funcs[no];
    const { endOf, elseOf } = this.regions(f);
    const used = this.usedRefs(f);
    const L = [];
    /* 形参就是前几个槽（降级器是这么分的）。缺席的实参在 interp 里补零值，
     * 这里用 JS 的默认参数 —— 同一个意思，而且热路径上不多一次判断。 */
    const ps = f.params.map((p, k) => `s${k} = ${jsZeroText(p.t)}`);
    L.push(`function $f${no}(${ps.join(', ')}) {`);
    for (let k = f.params.length; k < f.slots.length; k++) {
      L.push(`  let s${k} = ${jsZeroText(f.slots[k].t)};`);
    }
    const vs = [];
    for (const i of used) vs.push(`v${i}`);
    if (vs.length > 0) L.push(`  let ${vs.join(', ')};`);

    /* ---- `setjmp` 那一层（见 `SETJMP_NAMES` 的头注）。没有落点就一个字节都不多发。 */
    const sj = this.sjPlan(f, endOf, elseOf);
    const stack = [];
    let ind = '  ';
    if (sj !== null) {
      L.push('  let $rs = 0;');
      L.push('  let $jv = 0;');
      /* 一趟调用一个记号：同一个函数在栈上有好几份时（递归），longjmp 要认出是哪一份。 */
      L.push('  const $TOK = sjTok();');
      L.push('  $RETRY: for (;;) {');
      L.push('    try {');
      ind = '      ';
    }
    /* 一段"不在路上"的语句攒在这儿：到了路上的那条指令（或者区域的头尾）就落盘，
       落的时候裹一层 `if ($rs === 0)` —— 导航的时候整段跳过去。 */
    let group = [];
    let groupInd = ind;
    let groupAt = 0;
    const flush = () => {
      if (group.length === 0) return;
      /* 最后一个落点之后的那些段永远不会被跳过，不必裹。 */
      if (sj !== null && groupAt < sj.maxSite) {
        L.push(`${groupInd}if ($rs === 0) {`);
        for (const g of group) L.push(g);
        L.push(`${groupInd}}`);
      } else {
        for (const g of group) L.push(g);
      }
      group = [];
    };
    const push = (s) => {
      if (sj === null) { L.push(ind + s); return; }
      if (group.length === 0) { groupInd = ind; groupAt = this.at; }
      group.push(ind + s);
    };
    /** 路上那几条：先把攒着的落盘，再原样发出去（它们是 JS 的块结构，不能被裹）。 */
    const pushPath = (s) => { flush(); L.push(ind + s); };
    const onPath = (i) => sj !== null && sj.pathIdx.has(i);

    for (let i = 0; i < f.count(); i++) {
      this.at = i;
      const op = f.op[i];
      const x = f.aux[i];
      const emit = onPath(i) ? pushPath : push;
      if (op === OP.BLOCK) { emit(`L${i}: {`); stack.push(i); ind += '  '; continue; }
      if (op === OP.LOOP) { emit(`L${i}: while (true) {`); stack.push(i); ind += '  '; continue; }
      if (op === OP.IF) {
        /* 导航中（`$rs !== 0`）：这一支底下有没有那个落点，有就进，没有就走 else。
           原来那个条件在导航时**不看** —— 它的输入是上一趟算出来的，重算没有意义。 */
        const c = `${this.ref(f, f.a[i])} === true`;
        const th = sj === null ? null : sj.thenSites.get(i);
        const cond = onPath(i)
          ? `$rs === 0 ? (${c}) : (${th === undefined ? 'false' : th.map((p) => `$rs === ${p}`).join(' || ')})`
          : c;
        emit(`L${i}: if (${cond}) {`);
        stack.push(i);
        ind += '  ';
        continue;
      }
      if (op === OP.ELSE) { ind = ind.slice(2); emit('} else {'); ind += '  '; continue; }
      if (op === OP.END) {
        const s = stack.pop();
        ind = ind.slice(2);
        /* LOOP 落到底是**退出**循环（wasm 的 loop 不自动回头），所以补一条 break。
         * 少这一句就是死循环 —— 而它只在"真的能落到底"时才发得出来（不可达的话
         * V8 也不在意，那一句就是死代码）。 */
        if (f.op[s] === OP.LOOP) (onPath(i) ? pushPath : push)(`  break L${s};`);
        (onPath(i) ? pushPath : push)('}');
        continue;
      }
      if (op === OP.BR) { emit(this.jump(f, stack, x)); continue; }

      if (op === OP.BRIF) {
        push(`if (${this.ref(f, f.a[i])} === true) ${this.jump(f, stack, x)}`);
        continue;
      }
      if (op === OP.BRTABLE) {
        /* 跳表。下标是 i32 时它已经是 number；i64 那格要卸一次箱。负数与超界都落到
         * default —— 与 interp 那句「按无符号读，越界走兜底」等价（表长不会大到 2^31）。 */
        const levels = f.levelsOf(f.b[i]);
        const idx = this.refType(f, f.a[i]) === T_I32
          ? this.ref(f, f.a[i]) : `Number(${this.ref(f, f.a[i])})`;
        push(`switch (${idx}) {`);
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
        const st = this.stName(MSTORE_KINDS[memKindNo(x)], f.t[i]);
        const v = used.has(i) ? `v${i} = ${this.ref(f, f.b[i])}` : this.ref(f, f.b[i]);
        push(`${st}(${this.ref(f, f.a[i])}, ${memOff(x)}, ${v});`);
        continue;
      }
      /* ---- `setjmp` / `longjmp` 的调用点（见 `SETJMP_NAMES` 的头注） */
      if (op === OP.CALL && this.sjStub.has(f.a[i])) {
        const as = f.argsOf(f.b[i]).map((r) => this.ref(f, r));
        if (this.sjStub.get(f.a[i]) === 'longjmp') {
          /* 不回来 —— 抛一个记号，中间那些帧靠 JS 的异常自然退掉。 */
          push(`sjThrow(${as[0]}, ${as.length > 1 ? as[1] : '0'});`);
          continue;
        }
        /* 落点。三种情形要分开，**不能只写"是我就收、否则装一次"**：
         *   - `$rs === i`：这一跳是回到我这儿的 —— 拿回值、把导航关掉；
         *   - `$rs === 0`：正常跑到这儿 —— 往那个 `jmp_buf` 上装一次，回 0；
         *   - 别的（`$rs` 指着**另一个**落点）：什么都不做，让导航继续往下走。
         *     少了这一支，同一个函数里第二个 `setjmp` 就永远到不了。 */
        const zero = f.t[i] === T_I32 ? '0' : '0n';
        const set = used.has(i) ? `v${i} = ${zero}; sjSet(${as[0]}, $TOK, ${i});`
          : `sjSet(${as[0]}, $TOK, ${i});`;
        const back = used.has(i) ? `v${i} = $jv; $rs = 0;` : '$rs = 0;';
        pushPath(`if ($rs === ${i}) { ${back} } else if ($rs === 0) { ${set} }`);
        continue;
      }
      const e = this.expr(f, i);
      if (used.has(i)) push(`v${i} = ${e};`);
      else if (f.t[i] === T_VOID || this.effectful(f.op[i])) push(`${e};`);
      // 没人读、又没有副作用的纯运算：整条丢掉（降级器留下的死值不少）
    }
    flush();
    if (sj !== null) {
      L.push('      break $RETRY;');
      L.push('    } catch ($e) {');
      L.push('      const $t = sjCatch($e, $TOK);');
      L.push('      if ($t === null) throw $e;');
      L.push('      $rs = $t.site;');
      L.push('      $jv = $t.val;');
      L.push('      continue $RETRY;');
      L.push('    }');
      L.push('  }');
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
    /* 哪几个函数是 `setjmp` / `longjmp` 的桩 —— 要在发函数体**之前**算好
     * （调用点的改写要查这张表）。 */
    this.sjStub = this.sjStubs();
    const L = [JS_PROLOGUE];
    for (let i = 0; i < mir.globals.length; i++) L.push(`let $g${i} = undefined;`);
    const bodies = [];
    for (let no = 0; no < mir.funcs.length; no++) {
      /* **别的模块提供的那个函数**：桩的身子不发，直接 `import` 那一格当 `$f<no>`。
         线性内存腿上外部函数一律有桩（落点是 `CCALL name`），所以"这个名字是不是
         我自己定义的"只能问 `f.thunk`（前端记的，见 `externThunk`）。
         表里没有的名字照旧留桩 —— 那是 libc，宿主提供。 */
      const f = mir.funcs[no];
      if (this.modular && f.thunk !== null && f.thunk !== undefined && this.syms.has(f.thunk)) {
        this.needImport(this.syms.get(f.thunk), `$fn_${f.thunk} as $f${no}`);
        continue;
      }
      /* **没有身子的桩**（`tu` 档里按值收发 struct 的那几种，见 `externThunk`）：
         它只能由别的模块提供。表里没有就当场抛 —— 发一个空身子出去是静默答错
         （调它什么都不做，回 undefined）。 */
      if (this.modular && f.extern === true) {
        throw new OmniError(`mir.emit_js: undefined symbol '${f.thunk === null ? f.name : f.thunk}'`
          + '（按值收发 struct 的外部函数只能由别的模块提供）');
      }
      bodies.push(...this.func(no));
    }
    // 访问器在函数体发完之后才知道用了哪几个，但声明要在前面 —— 所以这里才拼
    for (const [kind, name] of this.ldFns) L.push(`const ${name} = memLoadFn(${JSON.stringify(kind)});`);
    for (const [kind, name] of this.stFns) L.push(`const ${name} = memStoreFn(${JSON.stringify(kind)});`);
    for (const [kind, name] of this.ldFnsN) L.push(`const ${name} = memLoadFnN(${JSON.stringify(kind)});`);
    for (const [kind, name] of this.stFnsN) L.push(`const ${name} = memStoreFnN(${JSON.stringify(kind)});`);
    L.push(...this.moduleBase());
    L.push(...bodies);
    // 函数表：CALLI（C 的函数指针）与 libc 回调（qsort 的比较器）都按它查
    const table = mir.funcs.map((f, no) => `$f${no}`).join(', ');
    L.push(`const $FN = [${table}];`);
    /* **libc 回调那扇门要换一次口径**（这一刀新增的一格）：libc 那一份是给解释器写的，
     * 它手里的整数一律 BigInt，而这里 i32 是 number。所以按被调函数的签名把实参装/卸一次：
     *   - 形参是 i32 的，BigInt -> number
     *   - 回值是 i32 的，number -> BigInt（libc 那边会拿它去算，混着两种数会当场抛）
     * 表是**发代码期**算好的（`$FNP` 每个形参一位、`$FNR` 回值一位），运行期只是查下标。
     * MIR 自己发出的 `CALLI` 不走这儿 —— 那一路两侧的表示本来就一致。 */
    const fnp = mir.funcs.map((f) => `[${f.params.map((p) => (p.t === T_I32 ? 1 : 0)).join(',')}]`);
    L.push(`const $FNP = [${fnp.join(', ')}];`);
    L.push(`const $FNR = [${mir.funcs.map((f) => (f.ret === T_I32 ? 1 : 0)).join(', ')}];`);
    /* **module 档走那张全程序的表**（第一百五十二片）：本地函数号出了这份 .js 就不认识
       （A 的 `37n` 到了 B 是 B 的第 37 个函数 —— 静默调错），所以指针值是
       `fnSlot(链接名)`、调用走 `fnCall`。本模块定义的（不是桩、有身子的）在装载期把身子
       放进去；"引用在前定义在后"也接得上，因为槽位按名字先到先得。 */
    if (this.modular) {
      for (let no = 0; no < mir.funcs.length; no += 1) {
        const f = mir.funcs[no];
        if (f.thunk !== null && f.thunk !== undefined && this.syms.has(f.thunk)) continue;
        if (f.extern === true) continue;
        if (f.count() === 0) continue;
        L.push(`fnBind(${JSON.stringify(this.linkKey(no))}, $f${no}, $FNP[${no}], $FNR[${no}]);`);
      }
      L.push('const $calli = (fp, args) => fnCall(fp, args);');
      L.push('const $callFromLibc = (fp, args) => fnCallLibc(fp, args);');
    } else {
      L.push(`const $calli = (fp, args) => {
  const no = Number(fp) - 1;
  if (no < 0) failRt('call of a null function pointer');
  if ($FN[no] === undefined) failRt('function pointer index ' + no + ' out of range');
  return $FN[no](...args);
};
const $callFromLibc = (fp, args) => {
  const no = Number(fp) - 1;
  if (no < 0) failRt('call of a null function pointer');
  const pt = $FNP[no];
  if (pt === undefined) failRt('function pointer index ' + no + ' out of range');
  const as = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k];
    as.push(pt[k] === 1 && typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : v);
  }
  const r = $FN[no](...as);
  return $FNR[no] === 1 && typeof r === 'number' ? BigInt(r) : r;
};`);
    }
    L.push(...this.runner());
    L.push(...this.linkage());
    /* import 是**最后**才拼的（哪几格要 import 得等函数体发完才知道），但 ESM 里
       import 语句可以在顶层任何位置 —— 声明是提升的，次序不影响。 */
    const head = [];
    for (const [spec, items] of this.imports) {
      head.push(`import { ${items.join(', ')} } from ${JSON.stringify(spec)};`);
    }
    return head.concat(L).join('\n') + '\n';
  }

  /**
   * module 档的**连接面**：我这份模块给外面什么。
   *
   * 两样，与 C 的符号表一一对应：
   *   * 函数 —— 本模块真定义的、非 `static` 的那些（`export { $f3 as $fn_add }`）；
   *   * 数据 —— `mod.dataSyms` 那些全局量的**地址**（`export const $sym_base = …`）。
   *     导出地址而不是值：C 那边它就是一块内存，读写都按地址走。
   *
   * 桩不导出（那是别人的符号），`static` 不导出（文件局部，两份模块可以同名）。
   */
  linkage() {
    if (!this.modular) return [];
    const mir = this.mir;
    const L = [];
    const items = [];
    for (let no = 0; no < mir.funcs.length; no++) {
      const f = mir.funcs[no];
      if (f.local === true) continue;
      if (f.thunk !== null && f.thunk !== undefined) continue;
      /* 只声明过、一条指令都没有的不导出（系统头带进来的那上百个名字）——
         导出了就等于"我提供这个符号"，那会把真正的定义顶掉。 */
      if (f.count() === 0) continue;
      items.push(`$f${no} as $fn_${f.name}`);
    }
    if (items.length > 0) L.push(`export { ${items.join(', ')} };`);
    return L;
  }

  /**
   * module 档的**装载期**那几句：占一段线性内存、算出与"烤死那一版"的差 `$D`，
   * 再把每一条地址常量算成 `基址 + 偏移`。
   *
   * 占的是**整张像**（`[64K, mem.min 页)`）而不只是 data 段：影子栈与堆的那几格基址
   * 也在这张像里（`tccgen` 按 `dataOff` 一路往上排），整块搬才能让它们仍然对得上
   * —— 与 `tests/mir/reloc.js` 搬的是同一块东西。
   */
  /**
   * 一个函数的**链接名**（module 档，第一百五十二片）：全程序那张函数表的键。
   *
   * 对外可见的函数就是它的名字；`static` 的挂上本模块自己的标记 —— 两份 `.c` 里各有
   * 一个 `static int cmp(...)` 是常事，共用一格就是**静默调错函数**。桩（别的模块提供的）
   * 按桩名走，那一格由**定义方**往里放身子。
   */
  linkKey(no) {
    const f = this.mir.funcs[no];
    const nm = f.thunk === null || f.thunk === undefined ? f.name : f.thunk;
    if (f.local === true) return `${this.modId === undefined ? this.mir.name : this.modId}#${nm}`;
    return nm;
  }

  moduleBase() {
    if (!this.modular) return [];
    const mir = this.mir;
    if (mir.mem === null) {
      if (this.addrRefs.size > 0) throw new OmniError('mir.emit_js: 没有内存却有地址常量');
      return [];
    }
    if (mir.mem.max !== 0) throw new OmniError('mir.emit_js: module 档还不支持内存页上限');
    const span = mir.mem.min * MEM_PAGE - MEM_PAGE;
    const L = [
      `const $B = memAlloc(${span}, 16);`,
      `const $D = $B - ${MEM_PAGE};`,
      'const $Dn = BigInt($D);',
    ];
    for (const r of this.addrRefs) {
      L.push(`const $k${r} = ${BigInt(mir.consts.items[r].text)}n + $Dn;`);
    }
    /* 函数指针那几格（第一百五十二片）：值 = 全程序那张表的槽位。键是**链接名** ——
       对外可见的就是名字，`static` 的挂上本模块的标记（值要全局唯一，但只有本模块引用）。 */
    for (const r of this.fnRefs) {
      L.push(`const $fp${r} = fnSlot(${JSON.stringify(this.linkKey(mir.funcRefs.get(r)))});`);
    }
    /* 本模块定义的全局量：把**地址**导出去（C 那边它就是一块内存）。
       别人那句 `import { $sym_base }` 接的就是这一格。 */
    for (const [name, addr] of mir.dataSyms === undefined ? [] : mir.dataSyms) {
      L.push(`export const $sym_${name} = ${BigInt(addr)}n + $Dn;`);
    }
    /* data 段在**装载期**就铺好（不像烤死那一版是在 `$run()` 里）：一份 .c 一份 .js
       之后，别人的代码可能先跑起来，那时我这一段必须已经在内存里。
       搬了一段之后段里装地址的那几格要跟着加同一个差 —— 哪几格由
       `mem.data[].relocs` 记着（这张表漏一条就是指向搬之前那块地方）。 */
    for (const d of mir.mem.data) {
      const rs = [];
      const fix = [];
      for (const r of d.relocs === undefined ? [] : d.relocs) {
        /* 这一格装的是**别人**那个符号的地址（`static int *p = &arr[2];`）：
           不是"加一个差"，而是"等提供方的地址" —— 发成一句写死的 `$sym_x + add`。
           表里找不到提供方就当场抛（成品那一层会把它报成 undefined symbol）——
           悄悄按"加一个差"铺下去会指着本模块预留的那块空白，那是静默答错。 */
        if (r.sym !== undefined) {
          if (!this.syms.has(r.sym)) {
            throw new OmniError(`mir.emit_js: data 段里指着外部符号 '${r.sym}'，但没人提供它`);
          }
          this.needImport(this.syms.get(r.sym), `$sym_${r.sym}`);
          fix.push(`[${r.at},$sym_${r.sym} + ${r.add === undefined ? 0 : r.add}n]`);
          continue;
        }
        rs.push(`[${r.at},${r.size}]`);
      }
      /* data 段里的**函数地址**（`static f_t tab[] = { do_a, do_b };`，R 的 `R_FunTab`
         就是这个形状）：同样不是"加一个差"，写的是那张全程序函数表的槽位。 */
      for (const r of d.relocs === undefined ? [] : d.relocs) {
        if (r.fn === undefined) continue;
        fix.push(`[${r.at},fnSlot(${JSON.stringify(this.linkKey(r.fn))})]`);
      }
      L.push(`memPut(${d.off} + $D, [${d.bytes.join(',')}], [${rs.join(',')}], $D`
        + `${fix.length > 0 ? `, [${fix.join(',')}]` : ''});`);
    }
    return L;
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
    /**
     * module 档里**有的模块只是一个库**（没有 `main` —— R 运行时那 122 份里的每一份都是）。
     * 那时它的入口函数只有"序"（`$sp` 的初值、errno/strerror/流那几格），没有 `main` 可调，
     * 所以发的是 `$init()` 而不是 `$run()`：
     *   * 不收退出码、不 `libcAtExit`（atexit 的手还没登记，收摊是程序的事，不是库的事）；
     *   * 由入口那一层在跑 `main` **之前**把每一份库的 `$init()` 叫一遍。
     */
    const lib = this.modular && !mir.funcIndex.has('main');
    this.hasRun = lib ? 'init' : true;
    const L = [lib ? 'function $init() {' : 'function $run() {'];
    if (mir.mem !== null && !this.modular) {
      L.push(`  memInit(${mir.mem.min}, ${mir.mem.max});`);
      /* data 段就是一串数字字面量。不走 base64/`Buffer`：**这一份自己也要能被 omni
       * 编译**（自举那条门），而 `Buffer` 不在封闭子集里。代价只是源码大一点，
       * 而 data 段只在装载时走一次。
       * module 档不在这儿铺 —— 那一档在**装载期**就铺好了（见 `moduleBase`）。 */
      for (const d of mir.mem.data) {
        L.push(`  memData(${d.off}, [${d.bytes.join(',')}]);`);
      }
    }
    L.push(`  setFnPtrCaller((ptr, args) => $callFromLibc(ptr, args));`);
    /* 共用的那个堆（module 档）：装载全完之后在内存尾上要一页，幂等。
       前端在 `tu` 档里只记一条 `wantsHeap`，基址不烤 —— 见那一格头上的账。 */
    if (this.modular && mir.wantsHeap === true) L.push('  memHeap();');
    if (lib) {
      L.push(`  $f${no}();`);
      L.push('}');
      return L;
    }
    L.push('  let code = 0;');
    L.push('  try {');
    L.push(`    const r = $f${no}();`);
    const ret = mir.funcs[no].ret;
    if (ret === T_VOID) L.push('    code = 0;');
    /* 退出码只留低 8 位（wait(2) 只传得下一个字节）。i32 上 `& 255` 就是 `asUintN(8)`
     * —— `return -1` 于是是 255，与 tcc 一致。 */
    else if (ret === T_I32) L.push('    code = r === undefined || r === null ? 0 : (r & 255);');
    else L.push('    code = r === undefined || r === null ? 0 : Number(BigInt.asUintN(8, BigInt(r)));');
    L.push('  } catch (e) {');
    L.push('    if (isExitCall(e)) { libcAtExit(); flushOut(); return e.code; }');
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
 *
 * `opts.module === true` 是**一个 .c 一个 .js** 那条路的档（ADR-0047）：地址不再烤成
 * 编译期的数，而是"模块基址 + 偏移" —— 基址由装载期的 `memAlloc` 给，内存是 rt 那
 * 一块共用的。哪些常量是地址、data 段里哪几格装的是地址，全靠前端记下的那两张表
 * （`mir.addrConsts` 与 `mem.data[].relocs`）；漏一条就是静默错地址，所以
 * `tests/mir/jsmod.js` 那道门专门把基址推开再跑。
 *
 * 这一档**不自己退出**：它 `export { $run }`，谁是程序入口由上面那一层说
 * （被 `import` 进来的模块里调 `process.exit()` 还会把 stdout 丢掉 —— 宿主的收摊次序）。
 */
export function emitMirJs(mir, opts) {
  const modular = opts !== undefined && opts.module === true;
  const syms = opts === undefined ? undefined : opts.symbols;
  const gen = new JsFromMir(mir, modular, syms);
  /* **这份模块自己的标记**（第一百五十二片）：`static` 函数进那张全程序函数表时挂在
     名字后头。两份 `.c` 里各有一个 `static int cmp(...)` 是常事，共用一格就是静默调错。
     缺省用 MIR 的模块名（JS 腿上那一格可能没名字），成品那一层传 `modId`（落盘路径）。 */
  if (opts !== undefined && opts.modId !== undefined) gen.modId = opts.modId;
  const src = gen.emit();
  const spec = opts === undefined ? undefined : opts.rtImport;
  if (spec === undefined) return src;
  const head = `import { RT as $rt } from ${JSON.stringify(spec)};\n`;
  if (modular) {
    /* 库那一档导出的是 `$init`（没有 `main` 可跑），程序那一档导出 `$run`。 */
    return `${head}${src}\nexport { ${gen.hasRun === 'init' ? '$init' : '$run'} };\n`;
  }
  return `${head}${src}\nprocess.exit($run());\n`;
}
