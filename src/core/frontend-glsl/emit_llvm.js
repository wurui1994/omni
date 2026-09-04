// src/core/frontend-glsl/emit_llvm.js —— GLSL 的 checked 树 -> 一份 `.ll`（8 道 f32 SoA）
//
// ADR-0019 决策六「快路」+ **决策十第 1 步**（分量带类型）。
//
// ---- 表示：一个分量 = `{ v, t }`，不是一段裸文本 ------------------------------------
//
// 这一版照 llvmpipe 的 gallivm 改（`mesa/src/gallium/auxiliary/gallivm/`）。它那边
// `struct lp_type`（`lp_bld_type.h:83-138`）把 `floating / sign / width / length` 记在
// 值上，SoA 上下文里并排放着 24 个 builder（`lp_bld_nir_soa.c:159-257`），取哪一个由
// `get_flt_bld` / `get_int_bld`（同文件 259-310）按「位宽 + 有无符号」挑。那份头文件
// 的原话正是上一版踩的坑：
//
//   The LLVM type system can't conveniently express all the things we care about on
//   the types used for intermediate computations, such as signed vs unsigned…
//
// 上一版把每个分量都当 `<8 x float>`，`int` 是「值恰好是整数的 float」、`bool` 是
// 「值只取 0.0/1.0 的 float」。代价不是理论上的：`int(x)` 一直没截断（量出来是真 bug）、
// `floatBitsToInt` 根本落不下来、位运算与整数取模也进不来。所以现在每个分量带一个
// 一个字母的类型：
//
//   'f' -> `<8 x float>`   'i' -> `<8 x i32>`（有符号）   'b' -> `<8 x i1>`
//
// 于是 `int(x)` 是一条 `fptosi`（往零截，正好是规范 5.4.1）、`floatBitsToInt` 是一条
// `bitcast`、`&&` 是一条 `and` —— 都不用"想办法"。
//
// bool 用 `<8 x i1>` 也是照它：`lp_bld_nir_soa.c:5942-5945` 的 bool builder 是
// `lp_uint_type(type)` 再 `width /= 32`，而 `if_cond`（同文件 2030-2038）把它 `SExt`
// 成整通道掩码。i1 与掩码之间在 LLVM 里是零成本的（`select` 直接吃 i1）。
//
// ---- 还没照它做的（决策十第 3–5 步，各自有待办）-------------------------------------
//
// - 可变量还在 SSA 里，不是 `alloca` + 掩码写（`lp_bld_ir_common.c:200-224`）。
//   所以 `if` 仍然是"快照两支的绑定再 select"，而 `break`/`continue`/`return`/循环
//   **结构上接不了** —— 那要掩码栈，不是一条 `select`。
// - 没有 `lp_build_skip_branch`（整块没人活着就跳过）。

import { OmniError } from '../source/diag.js';

/** 一道多少：8 道 f32 = 一个 256 位寄存器（M1 上是两条 128 位，clang 自己拆）。 */
export const GLSL_LANES = 8;

const LL_F = `<${GLSL_LANES} x float>`;
const LL_I = `<${GLSL_LANES} x i32>`;
const LL_B = `<${GLSL_LANES} x i1>`;

/** 分量类型字母 -> LLVM 类型文本。 */
function llTy(t) {
  if (t === 'f') return LL_F;
  if (t === 'i') return LL_I;
  if (t === 'b') return LL_B;
  throw new OmniError(`glsl/llvm: 认不出的分量类型 '${t}'`);
}

/** LLVM 的 `float` 字面量：十六进制的**双精度位模式**（末 29 位必须是 0）。 */
function llFloatBits(v) {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, Math.fround(v));
  const hi = b.getUint32(0).toString(16).padStart(8, '0');
  const lo = b.getUint32(4).toString(16).padStart(8, '0');
  return `0x${hi}${lo}`;
}

/** 三种常量分量。`splat (T v)` 是 clang 自己发的写法，读起来也短。 */
const llF = (v) => ({ v: `splat (float ${llFloatBits(v)})`, t: 'f' });
const llI = (n) => ({ v: `splat (i32 ${n})`, t: 'i' });
const llB = (b) => ({ v: `splat (i1 ${b ? 'true' : 'false'})`, t: 'b' });

/** 这个 GLSL 类型的**标量**落成哪个字母。矩阵的分量一律是 float（GLSL 没有整数矩阵）。 */
function llScalarT(t) {
  const b = t.k === 'vec' ? t.base : t.k === 'mat' ? 'float' : t.k;
  if (b === 'float') return 'f';
  if (b === 'int') return 'i';
  if (b === 'bool') return 'b';
  throw new OmniError(`glsl/llvm: 这一片收不了的分量类型 ${b}`);
}

/** 分量个数。 */
function llNComp(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'mat') return t.cols * t.rows;
  if (t.k === 'array') return t.n * llNComp(t.of);
  if (t.k === 'struct') {
    let n = 0;
    for (const f of t.fields) n += llNComp(f.ty);
    return n;
  }
  if (t.k === 'float' || t.k === 'int' || t.k === 'bool') return 1;
  throw new OmniError(`glsl/llvm: 这一片收不了的类型 ${t.k}`);
}

/**
 * **每一格**的类型字母。与 `lower.js` 的 `glslCompTys` 是同一个公式 —— 结构体的分量
 * 类型不是一种（`struct Segs { vec2 s0; vec2 s1; int n; }` 前四格 'f'、第五格 'i'），
 * 上一版"每格都是 float"就是在这儿把 `int` 那一格弄丢的。
 */
function llCompTys(t) {
  if (t.k === 'struct') {
    const out = [];
    for (const f of t.fields) for (const x of llCompTys(f.ty)) out.push(x);
    return out;
  }
  if (t.k === 'array') {
    const one = llCompTys(t.of);
    const out = [];
    for (let i = 0; i < t.n; i++) for (const x of one) out.push(x);
    return out;
  }
  const s = llScalarT(t);
  const out = [];
  for (let i = 0; i < llNComp(t); i++) out.push(s);
  return out;
}

/** 一个类型的零值分量（`decl` 不带初值、`out` 的初值都用它）。 */
function llZero(t) {
  if (t === 'f') return llF(0);
  if (t === 'i') return llI(0);
  return llB(false);
}

/** GLSL 内建 -> LLVM intrinsic（都有 `.v8f32` 的向量形，实参与结果都是 float）。 */
const LL_INTRIN = new Map([
  ['sin', 'llvm.sin'], ['cos', 'llvm.cos'], ['sqrt', 'llvm.sqrt'],
  ['abs', 'llvm.fabs'], ['floor', 'llvm.floor'], ['ceil', 'llvm.ceil'],
  ['pow', 'llvm.pow'], ['exp', 'llvm.exp'], ['log', 'llvm.log'],
  ['min', 'llvm.minnum'], ['max', 'llvm.maxnum'],
]);

/** 两个实参的那几个 intrinsic（`declare` 的形参个数按它算）。 */
const LL_INTRIN2 = new Set(['llvm.pow', 'llvm.minnum', 'llvm.maxnum']);

class GlslLlvmEmitter {
  constructor(mod) {
    this.mod = mod;
    this.n = 0;                 // SSA 计数
    this.allocas = [];          // 入口块那几条 `alloca`（决策十第 3 步）
    this.body = [];             // 函数体那几行
    this.scopes = [new Map()];  // 名字 -> 绑定（值或落点）
    this.need = new Set();      // 要 declare 的 intrinsic
    /* 当前的执行掩码（`null` = 八道全活）。它是 `update()` 从下面几层合成出来的 ——
     * 照 `lp_exec_mask`（`lp_bld_ir_common.h:50-103`）。 */
    this.execMask = null;
    this.condMask = null;       // if 那一层（进出就还原，所以是 SSA 值）
    this.condStack = [];        // 每层 `if` 压一条：{ cond, outer }
    /* 这三层放在 `alloca` 里 —— 它们要**跨迭代**活着。null = 现在不在那个语境里。 */
    this.brkPtr = null;         // break（当前最内层循环 / switch）
    this.contPtr = null;        // continue（当前最内层循环）
    this.retPtr = null;         // return（当前函数）
    this.labels = 0;            // 基本块编号
    this.fnByName = new Map();  // 用户函数（内联用）
    for (const f of mod.funcs) this.fnByName.set(f.name, f);
    this.inlining = [];         // 正在内联的函数名（GLSL 不许递归，撞上就骂）
    this.retSlot = null;        // 当前函数的返回值落点（void 时是 null）
  }

  /** 一个新的基本块标签。 */
  label(tag) { this.labels++; return `L${this.labels}_${tag}`; }

  fresh() { this.n++; return `%v${this.n}`; }

  /** 发一条指令，回一个类型为 `t` 的分量。 */
  emit(txt, t) {
    const r = this.fresh();
    this.body.push(`  ${r} = ${txt}`);
    return { v: r, t };
  }

  /* ------------------------------------------------ 落点：`alloca` + 掩码写
   *
   * 照 llvmpipe：可变的东西**一律在内存里**，写要过掩码
   * （`lp_bld_ir_common.c:200-224` 的 `lp_exec_mask_store`）：
   *
   *   dst = load ptr;  res = select(exec_mask, val, dst);  store res, ptr
   *
   * 为什么不留在 SSA 里：留在 SSA 里就没有一个"能被掩码盖住的落点"，于是 `if` 只能靠
   * 「快照两支的绑定再 select」，而 `break`/`continue`/`return`/循环**结构上接不了**
   * （那些要的是"掩码一路带下去"）。`alloca` 之后 -O2 的 mem2reg/SROA 会把大部分
   * 提回 SSA —— llvmpipe 也是靠这一点，不是靠自己少发 load/store。
   */

  /** 开 N 个落点（每格一个 `alloca`），回一个 `{ kind:'var', ptrs, tys }`。 */
  allocVar(name, tys, init) {
    const ptrs = [];
    for (let i = 0; i < tys.length; i++) {
      const p = `%p${this.n + 1}_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
      this.n++;
      this.allocas.push(`  ${p} = alloca ${llTy(tys[i])}, align 32`);
      ptrs.push(p);
      /* 初值**不过掩码**：它是这一格的第一次写，掩码外的道读到它也无所谓
       * （那些道读了也传不出去）。llvmpipe 那边同理，声明处是直白的 store。 */
      const raw = init === null ? llZero(tys[i]) : (init.length === 1 ? init[0] : init[i]);
      const v = tys[i] === 'f' ? this.toF(raw) : tys[i] === 'i' ? this.toI(raw) : this.toB(raw);
      this.body.push(`  store ${llTy(tys[i])} ${v.v}, ptr ${p}, align 32`);
    }
    return { kind: 'var', ptrs, tys };
  }

  /** 从落点读出那几格。 */
  loadVar(b) {
    const out = [];
    for (let i = 0; i < b.ptrs.length; i++) {
      out.push(this.emit(`load ${llTy(b.tys[i])}, ptr ${b.ptrs[i]}, align 32`, b.tys[i]));
    }
    return out;
  }

  /** 往一个落点写一格，过掩码。 */
  maskStore(b, ix, valc) {
    const t = b.tys[ix];
    const tt = llTy(t);
    const val = t === 'f' ? this.toF(valc) : t === 'i' ? this.toI(valc) : this.toB(valc);
    if (this.execMask === null) {
      this.body.push(`  store ${tt} ${val.v}, ptr ${b.ptrs[ix]}, align 32`);
      return;
    }
    const old = this.emit(`load ${tt}, ptr ${b.ptrs[ix]}, align 32`, t);
    const c = this.maskToI1(this.execMask);
    const res = this.emit(`select ${LL_B} ${c.v}, ${tt} ${val.v}, ${tt} ${old.v}`, t);
    this.body.push(`  store ${tt} ${res.v}, ptr ${b.ptrs[ix]}, align 32`);
  }

  /* ------------------------------------------------ 掩码：`lp_exec_mask` 的那几层
   *
   * 照 `lp_exec_mask`（`lp_bld_ir_common.h:50-103`）：执行掩码不是一个值，是**几层的
   * 合成** —— `cond`（if 栈）、`break`、`cont`、`ret`。`update()` 就是它的
   * `lp_exec_mask_update`：把几层与在一起。
   *
   * `break`/`cont`/`ret` 三层放在 `alloca` 里而不是 SSA 值里，因为它们要**跨迭代**活着
   * （循环回边那一侧读的是上一轮写进去的）。`cond` 不用，它进出 `if` 就还原。
   *
   * **掩码的类型是 `<8 x i32>`（全 1 / 全 0），不是 `<8 x i1>`** —— 照 llvmpipe 的
   * `int_vec_type`（`lp_bld_ir_common.h:56`）。第一版图省事用了 i1，结果 `break` 之后
   * 下一圈的掩码不生效（量出来的指纹：`jj` 对、`cnt` 多跑三圈）。这一格正是决策十说的
   * 「不自己简化」——它那边一直是整通道掩码，我们照抄。
   */

  /** 掩码 -> `<8 x i1>`（`select` 要的形）。 */
  maskToI1(m) {
    return this.emit(`icmp ne ${LL_I} ${m.v}, zeroinitializer`, 'b');
  }

  /** `<8 x i1>` -> 掩码（符号扩展成全 1 / 全 0，与 `if_cond` 里那条 `SExt` 同）。 */
  i1ToMask(c) {
    return this.emit(`sext ${LL_B} ${c.v} to ${LL_I}`, 'm');
  }

  /** 掩码取反。 */
  maskNot(m) {
    return this.emit(`xor ${LL_I} ${m.v}, ${llI(-1).v}`, 'm');
  }

  /** 几层与在一起。全是 null（八道全活）就回 null，省掉一堆 `and`。 */
  update() {
    let m = this.condMask;
    const negs = [];
    if (this.contPtr !== null) negs.push(this.contPtr);
    if (this.brkPtr !== null) negs.push(this.brkPtr);
    if (this.retPtr !== null) negs.push(this.retPtr);
    for (const p of negs) {
      const cur = this.emit(`load ${LL_I}, ptr ${p}, align 32`, 'm');
      const inv = this.maskNot(cur);
      m = m === null ? inv : this.emit(`and ${LL_I} ${m.v}, ${inv.v}`, 'm');
    }
    this.execMask = m;
  }

  /** 往一层掩码（`break`/`cont`/`ret` 那三个落点之一）里**并进**当前活着的那些道。 */
  raise(ptr) {
    const cur = this.emit(`load ${LL_I}, ptr ${ptr}, align 32`, 'm');
    const add = this.execMask === null ? llI(-1) : this.execMask;
    const next = this.emit(`or ${LL_I} ${cur.v}, ${add.v}`, 'm');
    this.body.push(`  store ${LL_I} ${next.v}, ptr ${ptr}, align 32`);
    this.update();
  }

  /** 开一个掩码落点，初值全 0（"还没有道走这条路"）。 */
  maskPtr(tag) {
    this.n++;
    const p = `%m${this.n}_${tag}`;
    this.allocas.push(`  ${p} = alloca ${LL_I}, align 32`);
    this.body.push(`  store ${LL_I} zeroinitializer, ptr ${p}, align 32`);
    return p;
  }

  /**
   * 开一个循环的 `break` 落点。初值**不是 0，是「进循环时已经不活着的那些道」** ——
   * 照 `lp_exec_bgnloop`：新循环的 break 掩码从**当前那一份**起算，旧的压栈保存。
   *
   * 少这一格会错，而且错法不直观：外层循环最后那一圈（条件已经不成立、整段本该被掩掉）
   * 一进内层循环，`brkPtr`/`contPtr` 就被换成内层那两个全 0 的，于是 `update()` 算出来
   * 又是"八道全活"——内层循环就真的跑了一遍，把数组改了。量出来的指纹正是这个：
   * `for (int i = 2; i < 3; i++)` 的体跑了**两轮**，第二轮本该全掩掉却生效了。
   */
  loopBrkPtr() {
    const p = this.maskPtr('brk');
    if (this.execMask !== null) {
      const dead = this.maskNot(this.execMask);
      this.body.push(`  store ${LL_I} ${dead.v}, ptr ${p}, align 32`);
    }
    return p;
  }

  /** 进一层 `if`：`cond &= c`。 */
  pushMask(cond) {
    const c = this.i1ToMask(this.toB(cond));
    this.condStack.push({ cond: c, outer: this.condMask });
    this.condMask = this.condMask === null ? c
      : this.emit(`and ${LL_I} ${this.condMask.v}, ${c.v}`, 'm');
    this.update();
  }

  /** 进 `else`：把最内那一层的条件取反再与外层合。 */
  invertMask() {
    const top = this.condStack[this.condStack.length - 1];
    const inv = this.maskNot(top.cond);
    this.condMask = top.outer === null ? inv
      : this.emit(`and ${LL_I} ${top.outer.v}, ${inv.v}`, 'm');
    this.update();
  }

  /** 出这一层 `if`：恢复外层。 */
  popMask() {
    const top = this.condStack.pop();
    this.condMask = top.outer;
    this.update();
  }

  /** 「还有道活着吗」——一条真分支的判据。 */
  anyActive(m) {
    const c = this.maskToI1(m);
    const bits = this.emit(`bitcast ${LL_B} ${c.v} to i${GLSL_LANES}`, 'x');
    return this.emit(`icmp ne i${GLSL_LANES} ${bits.v}, 0`, 'x');
  }

  bind(name, comps) {
    this.scopes[this.scopes.length - 1].set(name, { kind: 'val', comps });
  }

  /** 开一个可变绑定（落点在内存里）。 */
  bindVar(name, tys, init) {
    this.scopes[this.scopes.length - 1].set(name, this.allocVar(name, tys, init));
  }

  find(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const c = this.scopes[i].get(name);
      if (c !== undefined) return c;
    }
    throw new OmniError(`glsl/llvm: 找不到名字 '${name}'`);
  }

  /** 读一个名字的那几格（不可变的直接给值，可变的从落点 load）。 */
  readName(name) {
    const b = this.find(name);
    return b.kind === 'val' ? b.comps : this.loadVar(b);
  }

  /** 一个名字必须是可变的（要往里写）。 */
  varOf(name) {
    const b = this.find(name);
    if (b.kind !== 'var') throw new OmniError(`glsl/llvm: '${name}' 不能赋值`);
    return b;
  }

  /* ------------------------------------------------------------ 类型之间的三条边 */

  /** -> `<8 x float>`。`int` 走 `sitofp`、`bool` 走 `select`（规范：true 是 1.0）。 */
  toF(c) {
    if (c.t === 'f') return c;
    if (c.t === 'i') return this.emit(`sitofp ${LL_I} ${c.v} to ${LL_F}`, 'f');
    return this.emit(`select ${LL_B} ${c.v}, ${LL_F} ${llF(1).v}, ${LL_F} ${llF(0).v}`, 'f');
  }

  /** -> `<8 x i32>`。float 走 `fptosi`（**往零截**，正好是规范 5.4.1）、bool 走 `zext`。 */
  toI(c) {
    if (c.t === 'i') return c;
    if (c.t === 'f') return this.emit(`fptosi ${LL_F} ${c.v} to ${LL_I}`, 'i');
    return this.emit(`zext ${LL_B} ${c.v} to ${LL_I}`, 'i');
  }

  /** -> `<8 x i1>`。"非零即真"，与 C 同一条。 */
  toB(c) {
    if (c.t === 'b') return c;
    if (c.t === 'f') return this.emit(`fcmp une ${LL_F} ${c.v}, ${llF(0).v}`, 'b');
    return this.emit(`icmp ne ${LL_I} ${c.v}, ${llI(0).v}`, 'b');
  }

  /** 两个分量拉到同一个类型：有 float 就都 float，否则有 int 就都 int。 */
  same(a, b) {
    if (a.t === b.t) return [a, b];
    if (a.t === 'f' || b.t === 'f') return [this.toF(a), this.toF(b)];
    return [this.toI(a), this.toI(b)];
  }

  /* ------------------------------------------------------------ 算术 / 比较 / 逻辑 */

  /** `+ - * / %`。按类型挑指令 —— 整数走 `add`/`sdiv`/`srem`，不是浮点那一套。 */
  arith(op, ac, bc) {
    const pair = this.same(ac, bc);
    const a = pair[0];
    const b = pair[1];
    if (a.t === 'b') throw new OmniError(`glsl/llvm: bool 上没有 '${op}'`);
    if (a.t === 'f') {
      if (op === '%') throw new OmniError('glsl/llvm: % 只对整数（规范 5.9）');
      const ins = op === '+' ? 'fadd' : op === '-' ? 'fsub' : op === '*' ? 'fmul' : 'fdiv';
      return this.emit(`${ins} ${LL_F} ${a.v}, ${b.v}`, 'f');
    }
    const ins = op === '+' ? 'add' : op === '-' ? 'sub' : op === '*' ? 'mul'
      : op === '/' ? 'sdiv' : 'srem';
    return this.emit(`${ins} ${LL_I} ${a.v}, ${b.v}`, 'i');
  }

  /**
   * 比较 -> `<8 x i1>`。
   *
   * 浮点用**有序**那一档（`olt`/`oeq`…），`!=` 用 `une` —— 与 C 的 `==`/`!=` 对 NaN
   * 的结果一致（NaN != NaN 是真）。整数用 `icmp` 的有符号那一档。
   */
  cmp(op, ac, bc) {
    const pair = this.same(ac, bc);
    const a = pair[0];
    const b = pair[1];
    if (a.t === 'f') {
      const pf = { '<': 'olt', '<=': 'ole', '>': 'ogt', '>=': 'oge', '==': 'oeq', '!=': 'une' }[op];
      if (pf === undefined) throw new OmniError(`glsl/llvm: 认不出的比较 '${op}'`);
      return this.emit(`fcmp ${pf} ${LL_F} ${a.v}, ${b.v}`, 'b');
    }
    if (a.t === 'b') {
      if (op !== '==' && op !== '!=') throw new OmniError(`glsl/llvm: bool 上只有 == 与 !=，给的是 '${op}'`);
      return this.emit(`icmp ${op === '==' ? 'eq' : 'ne'} ${LL_B} ${a.v}, ${b.v}`, 'b');
    }
    const pi = { '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge', '==': 'eq', '!=': 'ne' }[op];
    if (pi === undefined) throw new OmniError(`glsl/llvm: 认不出的比较 '${op}'`);
    return this.emit(`icmp ${pi} ${LL_I} ${a.v}, ${b.v}`, 'b');
  }

  /** `&& || ^^` —— i1 上的 `and`/`or`/`xor`。**两边都算**：SIMD 上没有短路
   * （llvmpipe 也一样，两支都算再靠掩码取）。 */
  logic(op, ac, bc) {
    const a = this.toB(ac);
    const b = this.toB(bc);
    const ins = op === '&&' ? 'and' : op === '||' ? 'or' : 'xor';
    return this.emit(`${ins} ${LL_B} ${a.v}, ${b.v}`, 'b');
  }

  /** `select`：两支拉到同一类型再发。 */
  select(mc, ac, bc) {
    const m = this.toB(mc);
    const pair = this.same(ac, bc);
    const a = pair[0];
    const b = pair[1];
    const tt = llTy(a.t);
    return this.emit(`select ${LL_B} ${m.v}, ${tt} ${a.v}, ${tt} ${b.v}`, a.t);
  }

  /** 一元 `-`。 */
  neg(c) {
    if (c.t === 'f') return this.emit(`fneg ${LL_F} ${c.v}`, 'f');
    if (c.t === 'i') return this.emit(`sub ${LL_I} ${llI(0).v}, ${c.v}`, 'i');
    throw new OmniError('glsl/llvm: bool 上没有一元 -');
  }

  /** 调一个 float intrinsic（实参全先拉成 float）。 */
  call1(fn, args) {
    this.need.add(fn);
    const as = [];
    for (const a of args) as.push(`${LL_F} ${this.toF(a).v}`);
    return this.emit(`call ${LL_F} @${fn}.v${GLSL_LANES}f32(${as.join(', ')})`, 'f');
  }

  /* ------------------------------------------------------------ 表达式 */

  /** 一个表达式 -> 分量数组（每格一个 `{ v, t }`）。 */
  expr(e) {
    if (e.k === 'lit') {
      if (e.ty.k === 'bool') return [llB(e.v ? true : false)];
      if (e.ty.k === 'int') return [llI(String(e.v))];
      return [llF(Number(e.v))];
    }
    if (e.k === 'ref') return this.readName(e.name);
    if (e.k === 'swizzle') {
      /* 局部量**不能叫 `of`** —— 那是自编译子集词法里的关键字（`for … of`）。
       * 节点属性叫 `e.of` 没关系，受限的只有绑定名。 */
      const subj = this.expr(e.of);
      return e.idx.map((ix) => subj[ix]);
    }
    if (e.k === 'splat') {
      const v = this.expr(e.of)[0];
      const out = [];
      for (let i = 0; i < llNComp(e.ty); i++) out.push(v);
      return out;
    }
    if (e.k === 'field') {
      /* 结构体的成员（B13）：分量表里连着的那一段，起始格号由检查那一侧算好放在 `at` 上。 */
      const subj = this.expr(e.of);
      return subj.slice(e.at, e.at + llNComp(e.ty));
    }
    if (e.k === 'aindex') return this.aindex(e);
    if (e.k === 'construct') {
      /* 构造是「按源码次序把实参的分量接起来」，但**每一格要按目标类型摆正** ——
       * `ivec2(1.0, 2.0)` 的两格是 int。检查那一侧已经把类型定好了，这儿只做转换。 */
      const raw = [];
      for (const a of e.args) for (const c of this.expr(a)) raw.push(c);
      return this.fit(raw, e.ty);
    }
    if (e.k === 'cast' || e.k === 'convert') {
      const v = this.expr(e.of);
      return this.fit(v, e.ty);
    }
    if (e.k === 'neg') return this.expr(e.a).map((c) => this.neg(c));
    if (e.k === 'not') {
      /* `!b` —— i1 上的 `xor … true`。上一版是 `1 - x`（float-bool 那套的残留）。 */
      const a = this.toB(this.expr(e.a)[0]);
      return [this.emit(`xor ${LL_B} ${a.v}, ${llB(true).v}`, 'b')];
    }
    if (e.k === 'bnot') {
      /* `~x` —— 整数上的 `xor … -1`。上一版根本收不了（int 是 float）。 */
      const a = this.toI(this.expr(e.a)[0]);
      return [this.emit(`xor ${LL_I} ${a.v}, ${llI(-1).v}`, 'i')];
    }
    if (e.k === 'bin') return this.bin(e);
    if (e.k === 'sel') {
      /* `c ? a : b` -> 一条 `select`。**两支都算** —— 8 道里可能有的走这支、有的走那支，
       * 所以"不该走的那支里有除零"会真的算出 Inf/NaN，但那一格选不中，传不出去。 */
      const m = this.expr(e.c)[0];
      const a = this.expr(e.a);
      const b = this.expr(e.b);
      const n = a.length > b.length ? a.length : b.length;
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(this.select(m, a.length === 1 ? a[0] : a[i], b.length === 1 ? b[0] : b[i]));
      }
      return out;
    }
    if (e.k === 'builtin') return this.builtin(e);
    if (e.k === 'call') return this.inlineCall(e);
    if (e.k === 'bits') {
      /* 位转换（规范 8.4）—— **一条 `bitcast`**。这就是决策十第 1 步兑的钱：上一版这儿
       * 只能骂 NYI，因为 `int` 不是真的 `<8 x i32>`。
       *
       * 宽度这一格与参照腿**不同**（那边是 f64/i64，见 `check.js` 的注释）：这一层是
       * f32/i32，正好是规范说的 32 位。两边对着两张不同的参考图。 */
      const a = this.expr(e.args[0]);
      if (e.name === 'floatBitsToInt') {
        return a.map((c) => this.emit(`bitcast ${LL_F} ${this.toF(c).v} to ${LL_I}`, 'i'));
      }
      return a.map((c) => this.emit(`bitcast ${LL_I} ${this.toI(c).v} to ${LL_F}`, 'f'));
    }
    /* 赋值是**表达式**（`fragColor = …` 出来是 `{k:'expr', e:{k:'assign'}}`）。 */
    if (e.k === 'assign') return this.assign(e);
    if (e.k === 'incdec') {
      /* `i++` / `--j`。**读一次、算一次、写回去**，写那一步过掩码（走 `assign` 同一条路，
       * 形状与 `i = i + 1` 一字不差）。只收标量 —— GLSL 里向量上也能写，但尺子里没有。 */
      const before = this.expr(e.a);
      if (before.length !== 1) throw new OmniError('glsl/llvm: ++/-- 这一片只收标量');
      const one = before[0].t === 'i' ? llI(1) : llF(1);
      const op = e.op === 'pre-inc' || e.op === 'post-inc' ? '+' : '-';
      const next = this.arith(op, before[0], one);
      this.assign({ op: '=', lhs: e.a, rhs: { k: 'pre', comps: [next] } });
      /* 后缀回**改之前**那个值；前缀回改之后的。 */
      return e.op === 'post-inc' || e.op === 'post-dec' ? before : [next];
    }
    /* 内部用：一串已经算好的分量当表达式递给 `assign`（`incdec` 用它，不是语法里的东西）。 */
    if (e.k === 'pre') return e.comps;
    throw new OmniError(`glsl/llvm: 这一片收不了的表达式 ${e.k}`);
  }

  /** 把一串分量按目标类型逐格摆正（构造与转换都走这一处）。 */
  fit(comps, ty) {
    const want = llCompTys(ty);
    const out = [];
    for (let i = 0; i < comps.length; i++) {
      const w = want.length === 1 ? want[0] : want[i];
      const c = comps[i];
      out.push(w === 'f' ? this.toF(c) : w === 'i' ? this.toI(c) : this.toB(c));
    }
    return out;
  }

  /** 数组取一格（B14）。常量下标是切片；变量下标是 select 链（8 道的下标不一样）。 */
  aindex(e) {
    const subj = this.expr(e.of);
    const w = llNComp(e.ty);
    if (e.at.k === 'lit') return subj.slice(e.at.v * w, e.at.v * w + w);
    const idx = this.toI(this.expr(e.at)[0]);
    const cts = llCompTys(e.ty);
    const acc = [];
    for (let j = 0; j < w; j++) acc.push(llZero(cts[j]));
    for (let k = 0; k < e.of.ty.n; k++) {
      /* 下标现在是**真整数**，所以这儿是 `icmp eq` —— 上一版用 `fcmp oeq` 是因为
       * 那时候 `int` 是 float，而那正是 `int(x)` 那个 bug 的同一个根。 */
      const m = this.emit(`icmp eq ${LL_I} ${idx.v}, ${llI(k).v}`, 'b');
      for (let j = 0; j < w; j++) acc[j] = this.select(m, subj[k * w + j], acc[j]);
    }
    return acc;
  }

  bin(e) {
    const op = e.op;
    if (op === '<' || op === '<=' || op === '>' || op === '>='
      || op === '==' || op === '!=') {
      const a = this.expr(e.a);
      const b = this.expr(e.b);
      if (a.length === 1 && b.length === 1) return [this.cmp(op, a[0], b[0])];
      /* 向量的 `==`/`!=` 回**一个** bool（规范 5.9）：逐格比完折起来。
       * 逐格出掩码的是 `equal`/`notEqual` 那一族，不是这儿。 */
      const n = a.length > b.length ? a.length : b.length;
      let acc = null;
      for (let i = 0; i < n; i++) {
        const c = this.cmp(op, a.length === 1 ? a[0] : a[i], b.length === 1 ? b[0] : b[i]);
        acc = acc === null ? c : this.logic(op === '==' ? '&&' : '||', acc, c);
      }
      return [acc];
    }
    if (op === '&&' || op === '||' || op === '^^') {
      return [this.logic(op, this.expr(e.a)[0], this.expr(e.b)[0])];
    }
    if (op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>') {
      /* 位运算与移位（规范 5.9，只对整数）。上一版一条都收不了。
       * 移位用**算术**右移（`ashr`）—— GLSL 的 `int` 是有符号的。 */
      const a = this.expr(e.a);
      const b = this.expr(e.b);
      const n = a.length > b.length ? a.length : b.length;
      const ins = op === '&' ? 'and' : op === '|' ? 'or' : op === '^' ? 'xor'
        : op === '<<' ? 'shl' : 'ashr';
      const out = [];
      for (let i = 0; i < n; i++) {
        const x = this.toI(a.length === 1 ? a[0] : a[i]);
        const y = this.toI(b.length === 1 ? b[0] : b[i]);
        out.push(this.emit(`${ins} ${LL_I} ${x.v}, ${y.v}`, 'i'));
      }
      return out;
    }
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/' && op !== '%') {
      throw new OmniError(`glsl/llvm: 这一片收不了的算符 ${op}`);
    }
    const a = this.expr(e.a);
    const b = this.expr(e.b);
    const n = a.length > b.length ? a.length : b.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(this.arith(op, a.length === 1 ? a[0] : a[i], b.length === 1 ? b[0] : b[i]));
    }
    return out;
  }

  builtin(e) {
    const name = e.name;
    const args = e.args.map((a) => this.expr(a));
    /* `Math.max(...xs)` 的展开自编译子集不收 —— 显式取最大。 */
    let wide = 0;
    for (const a of args) if (a.length > wide) wide = a.length;
    /* `at` 的两个形参**刻意不叫 `k`/`i`**：自编译那侧的「闭包捕获循环变量」是按
     * **函数**粒度 + 按名字判的，箭头函数里出现 `i` 就会把这个函数里所有
     * `for (let i …)` 都骂一遍（量过：改个名字 13 条错变 9 条）。形参名错开就没这回事。 */
    const at = (ak, ai) => (args[ak].length === 1 ? args[ak][0] : args[ak][ai]);
    /* 整数上的 `abs`/`min`/`max`（规范 8.3）：**不能**转成 float 再算 —— 那在大整数上
     * 会掉精度。上一版没有这一支（int 就是 float，所以问题看不见）。 */
    const isInt = args.length > 0 && args[0][0].t === 'i';
    if (isInt && (name === 'abs' || name === 'min' || name === 'max')) {
      const out = [];
      for (let i = 0; i < wide; i++) {
        if (name === 'abs') {
          const x = at(0, i);
          out.push(this.select(this.cmp('<', x, llI(0)), this.neg(x), x));
        } else {
          const x = at(0, i);
          const y = at(1, i);
          out.push(this.select(this.cmp(name === 'min' ? '<' : '>', x, y), x, y));
        }
      }
      return out;
    }
    const fn = LL_INTRIN.get(name);
    if (fn !== undefined) {
      const out = [];
      for (let i = 0; i < wide; i++) {
        /* 这儿刻意**不写** `args.map((_, k) => at(k, i))`：闭包捕获 `for` 的循环变量，
         * 自编译那个子集不收（JS 的 `let` 每轮一个新绑定，C 那边不是）。显式循环取。 */
        const lane = [];
        for (let k = 0; k < args.length; k++) lane.push(at(k, i));
        out.push(this.call1(fn, lane));
      }
      return out;
    }
    if (name === 'length' || name === 'distance' || name === 'dot') {
      const a = args[0];
      const b = name === 'dot' || name === 'distance' ? args[1] : null;
      let sum = null;
      for (let i = 0; i < a.length; i++) {
        const x = name === 'distance' ? this.arith('-', a[i], b[i]) : a[i];
        const y = name === 'dot' ? b[i] : x;
        const p = this.arith('*', x, y);
        sum = sum === null ? p : this.arith('+', sum, p);
      }
      return [name === 'dot' ? sum : this.call1('llvm.sqrt', [sum])];
    }
    if (name === 'fract') {
      return args[0].map((c) => this.arith('-', c, this.call1('llvm.floor', [c])));
    }
    if (name === 'clamp') {
      const out = [];
      for (let i = 0; i < wide; i++) {
        const lo = this.call1('llvm.maxnum', [at(0, i), at(1, i)]);
        out.push(this.call1('llvm.minnum', [lo, at(2, i)]));
      }
      return out;
    }
    if (name === 'mix') {
      /* 照规范那个形状：`x*(1-a) + y*a`（不写成 x + (y-x)*a —— 浮点下不等价）。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const a0 = this.toF(at(2, i));
        const one = this.arith('-', llF(1), a0);
        out.push(this.arith('+', this.arith('*', at(0, i), one), this.arith('*', at(1, i), a0)));
      }
      return out;
    }
    if (name === 'normalize') {
      let sum = null;
      for (const c of args[0]) {
        const p = this.arith('*', c, c);
        sum = sum === null ? p : this.arith('+', sum, p);
      }
      const len = this.call1('llvm.sqrt', [sum]);
      return args[0].map((c) => this.arith('/', c, len));
    }
    if (name === 'smoothstep') {
      const out = [];
      for (let i = 0; i < wide; i++) {
        const num = this.arith('-', at(2, i), at(0, i));
        const den = this.arith('-', at(1, i), at(0, i));
        let t = this.arith('/', num, den);
        t = this.call1('llvm.maxnum', [t, llF(0)]);
        t = this.call1('llvm.minnum', [t, llF(1)]);
        const tt = this.arith('*', t, t);
        const three = this.arith('-', llF(3), this.arith('*', llF(2), t));
        out.push(this.arith('*', tt, three));
      }
      return out;
    }
    if (name === 'step') {
      /* 规范 8.3：`x < edge ? 0.0 : 1.0`。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        out.push(this.select(this.cmp('<', at(1, i), at(0, i)), llF(0), llF(1)));
      }
      return out;
    }
    if (name === 'isnan') {
      /* NaN 是唯一「无序于自己」的值 —— 一条 `fcmp uno`。 */
      return args[0].map((c) => this.emit(`fcmp uno ${LL_F} ${this.toF(c).v}, ${this.toF(c).v}`, 'b'));
    }
    if (name === 'isinf') {
      /* `|x| == +Inf`。参照实现那条路写的是 `x == x && (x-x) != 0` —— 那是因为方言的
       * `real` 是 f64，写死「最大有限值」会跟 f32 差一个数。这里宽度是定的（f32），
       * 直接与 +Inf 比，两条在数学上完全等价，所以对账门照旧成立。 */
      return args[0].map((c) => this.cmp('==', this.call1('llvm.fabs', [c]), llF(Infinity)));
    }
    const vcmp = { lessThan: '<', lessThanEqual: '<=', greaterThan: '>', greaterThanEqual: '>=', equal: '==', notEqual: '!=' }[name];
    if (vcmp !== undefined) {
      const out = [];
      for (let i = 0; i < wide; i++) out.push(this.cmp(vcmp, at(0, i), at(1, i)));
      return out;
    }
    if (name === 'all' || name === 'any') {
      let acc = null;
      for (const c of args[0]) {
        acc = acc === null ? this.toB(c) : this.logic(name === 'all' ? '&&' : '||', acc, c);
      }
      return [acc === null ? llB(name === 'all') : acc];
    }
    if (name === 'not') {
      return args[0].map((c) => this.emit(`xor ${LL_B} ${this.toB(c).v}, ${llB(true).v}`, 'b'));
    }
    throw new OmniError(`glsl/llvm: 这一片还没接的内建 ${name}`);
  }

  /* ------------------------------------------------------------ 语句 */

  stmt(s) {
    if (s.k === 'empty') return;
    if (s.k === 'block') {
      this.scopes.push(new Map());
      for (const x of s.body) this.stmt(x);
      this.scopes.pop();
      return;
    }
    if (s.k === 'expr') { this.expr(s.e); return; }
    /* 一条声明里多个变量（B15）：几条 `decl` 挨着走，**不压作用域**。 */
    if (s.k === 'multi') {
      for (const d of s.list) this.stmt(d);
      return;
    }
    if (s.k === 'decl') {
      /* 局部量是一个**落点**（决策十第 3 步）：`alloca` 一格一个，写走掩码。
       * 上一版是"当前那几格 SSA 值"，那样掩码盖不住它。 */
      const tys = llCompTys(s.ty);
      const vals = s.init === null ? null : this.expr(s.init);
      this.bindVar(s.name, tys, vals);
      return;
    }
    if (s.k === 'assign') { this.assign(s.e); return; }
    if (s.k === 'if') { this.ifStmt(s); return; }
    if (s.k === 'break') {
      if (this.brkPtr === null) throw new OmniError('glsl/llvm: break 不在循环里');
      this.raise(this.brkPtr);
      return;
    }
    if (s.k === 'continue') {
      if (this.contPtr === null) throw new OmniError('glsl/llvm: continue 不在循环里');
      this.raise(this.contPtr);
      return;
    }
    if (s.k === 'ret') {
      /* 带值的 `return`：先把值写进这一层的返回落点（过掩码），再往 `retPtr` 上并一层。
       * 与 `break` 是同一个机制 —— 差别只在"哪一层掩码"。 */
      if (s.e !== null && s.e !== undefined) {
        if (this.retSlot === null) throw new OmniError('glsl/llvm: void 函数里 return 带了值');
        const vals = this.expr(s.e);
        for (let i = 0; i < this.retSlot.ptrs.length; i++) {
          this.maskStore(this.retSlot, i, vals.length === 1 ? vals[0] : vals[i]);
        }
      }
      if (this.retPtr === null) throw new OmniError('glsl/llvm: return 不在函数里');
      this.raise(this.retPtr);
      return;
    }
    if (s.k === 'while') { this.loopStmt(s, 'while'); return; }
    if (s.k === 'dowhile') { this.loopStmt(s, 'do'); return; }
    if (s.k === 'for') { this.loopStmt(s, 'for'); return; }
    throw new OmniError(`glsl/llvm: 这一片收不了的语句 ${s.k}`);
  }

  /**
   * 循环 —— 一条**真循环**（`lp_exec_bgnloop` / `lp_exec_endloop`，用法见
   * `lp_bld_nir_soa.c:5809-5817`），不是展开。
   *
   * 条件落成「开头（`do while` 是末尾）的一次 `break`」—— 与 NIR 把 `for` 降成
   * `loop { if (!c) break; …; step }` 是同一个形状。回边的判据是「**还有道活着吗**」，
   * 所以八道里跑得最久的那一道决定圈数（llvmpipe 也是这样，SIMD 上没有别的办法）。
   */
  loopStmt(s, kind) {
    /* `for` 的 init 声明的名字要活到循环结束，所以这一层作用域套在外面。 */
    this.scopes.push(new Map());
    if (kind === 'for' && s.init !== null && s.init !== undefined) this.stmt(s.init);
    const outerBrk = this.brkPtr;
    const outerCont = this.contPtr;
    const brk = this.loopBrkPtr();
    const cont = this.maskPtr('cont');
    const head = this.label('loop');
    const end = this.label('endloop');
    this.body.push(`  br label %${head}`);
    this.body.push(`${head}:`);
    /* 每一轮开头把 cont 清掉 —— 它只管这一轮（`lp_exec_endloop` 也是在这儿重置的）。 */
    this.body.push(`  store ${LL_I} zeroinitializer, ptr ${cont}, align 32`);
    this.brkPtr = brk;
    this.contPtr = cont;
    this.update();
    if (kind !== 'do') this.loopCond(s.c);
    this.stmt(s.body);
    if (kind === 'for' && s.step !== null && s.step !== undefined) {
      /* `continue` 之后 `for` 的 step **照样执行**（与 C 同）。办法是算 step 的时候
       * 把 cont 那一层从掩码里摘掉。 */
      this.contPtr = null;
      this.update();
      this.expr(s.step);
      this.contPtr = cont;
      this.update();
    }
    if (kind === 'do') this.loopCond(s.c);
    const any = this.anyActive(this.aliveMask(brk));
    this.body.push(`  br i1 ${any.v}, label %${head}, label %${end}`);
    this.body.push(`${end}:`);
    this.brkPtr = outerBrk;
    this.contPtr = outerCont;
    this.update();
    this.scopes.pop();
  }

  /** 循环条件 = 「条件不成立的那些道 break 掉」。`for (;;)` 的条件是 null。 */
  loopCond(c) {
    if (c === null || c === undefined) return;
    const v = this.toB(this.expr(c)[0]);
    const inv = this.emit(`xor ${LL_B} ${v.v}, ${llB(true).v}`, 'b');
    this.pushMask(inv);
    this.raise(this.brkPtr);
    this.popMask();
  }

  /** 还留在循环里的那些道：外层 cond & 没 break & 没 return。 */
  aliveMask(brk) {
    const cur = this.emit(`load ${LL_I}, ptr ${brk}, align 32`, 'm');
    let m = this.maskNot(cur);
    if (this.condMask !== null) {
      m = this.emit(`and ${LL_I} ${this.condMask.v}, ${m.v}`, 'm');
    }
    if (this.retPtr !== null) {
      const r = this.emit(`load ${LL_I}, ptr ${this.retPtr}, align 32`, 'm');
      m = this.emit(`and ${LL_I} ${m.v}, ${this.maskNot(r).v}`, 'm');
    }
    return m;
  }

  /**
   * `if` —— 往掩码栈上压一层，两支都走一遍（`lp_bld_nir_soa.c:2030-2051` 的
   * `if_cond` / `else_stmt` / `endif_stmt`）。
   *
   * **合并那一步没有了**：值都在落点里，写都过掩码，所以"哪几格变了"这件事由
   * `select` 在 store 那一处自己解决。上一版要「快照两支的绑定、逐个比较、只 select
   * 变了的」，那是因为值在 SSA 里 —— 而那也正是 `break`/`continue`/循环接不了的原因。
   *
   * 还没做的一格：llvmpipe 在这外面还套一条 `lp_build_skip_branch`（整块没有一个道
   * 活着就跳过去），只在"单块且指令数 < 8"时才不套。那是纯性能，留给下一步。
   */
  ifStmt(s) {
    this.pushMask(this.expr(s.c)[0]);
    if (s.then !== null && s.then !== undefined) this.stmt(s.then);
    if (s.else !== null && s.else !== undefined) {
      this.invertMask();
      this.stmt(s.else);
    }
    this.popMask();
  }

  /**
   * 用户函数 —— **内联展开**。
   *
   * 这是照 llvmpipe 的：mesa 在把 NIR 交给 gallivm 之前就跑了 `nir_inline_functions`，
   * 真生成函数调用（`LP_RESV_FUNC_ARGS`：exec mask + context 两个保留参数，
   * `lp_bld_nir.h:40-44`）只有 CL 内核那一路 —— 图形着色器全内联。
   *
   * 内联在这套掩码架构里几乎是免费的：形参就是几个落点（`alloca`），`return` 就是往
   * `retPtr` 上并一层掩码 —— 与 `break` 同一个机制。递归不用管终止性：GLSL 明着禁止
   * 递归（规范 6.1），撞上就骂。
   */
  inlineCall(e) {
    const f = this.fnByName.get(e.name);
    if (f === undefined) throw new OmniError(`glsl/llvm: 没见过的函数 '${e.name}'`);
    if (this.inlining.indexOf(e.name) >= 0) {
      throw new OmniError(`glsl/llvm: '${e.name}' 递归了（GLSL 不许递归，规范 6.1）`);
    }
    /* 实参在**调用者**的作用域里算。 */
    const argVals = e.args.map((a) => this.expr(a));
    /* 被调者只看得见模块那一层（uniform / const），看不见调用者的局部量 —— 所以换掉
     * 整条作用域链，只留第 0 层。 */
    const savedScopes = this.scopes;
    const savedRet = this.retPtr;
    const savedSlot = this.retSlot;
    this.scopes = [savedScopes[0], new Map()];
    this.retPtr = this.maskPtr('ret');
    this.retSlot = f.ret.k === 'void' ? null
      : this.allocVar(`${e.name}_ret`, llCompTys(f.ret), null);
    for (let i = 0; i < f.params.length; i++) {
      const p = f.params[i];
      /* `out` 形参进去时不带值（规范 6.1.1），`in`/`inout` 带。 */
      const init = p.dir === 'out' ? null : argVals[i];
      this.scopes[1].set(p.name, this.allocVar(`${e.name}_${p.name}`, llCompTys(p.ty), init));
    }
    this.inlining.push(e.name);
    this.update();
    this.stmt(f.body);
    this.inlining.pop();
    /* `out`/`inout` 要写回调用者的左值。值先读出来 —— 这时候还在被调者的作用域里。 */
    const backs = [];
    for (let i = 0; i < f.params.length; i++) {
      const p = f.params[i];
      if (p.dir === 'in') continue;
      backs.push({ node: e.args[i], comps: this.loadVar(this.scopes[1].get(p.name)) });
    }
    const out = this.retSlot === null ? [] : this.loadVar(this.retSlot);
    this.scopes = savedScopes;
    this.retPtr = savedRet;
    this.retSlot = savedSlot;
    this.update();
    for (const b of backs) {
      this.assign({ op: '=', lhs: b.node, rhs: { k: 'pre', comps: b.comps } });
    }
    return out;
  }

  assign(e) {
    if (e.op !== '=') throw new OmniError(`glsl/llvm: 这一片只收 =，给的是 ${e.op}`);
    const lhs = e.lhs;
    const vals = this.expr(e.rhs);
    if (lhs.k === 'ref') {
      const b = this.varOf(lhs.name);
      for (let i = 0; i < b.ptrs.length; i++) {
        this.maskStore(b, i, vals.length === 1 ? vals[0] : vals[i]);
      }
      return vals;
    }
    if (lhs.k === 'swizzle' && lhs.of.k === 'ref') {
      const b = this.varOf(lhs.of.name);
      for (let li = 0; li < lhs.idx.length; li++) {
        this.maskStore(b, lhs.idx[li], vals.length === 1 ? vals[0] : vals[li]);
      }
      return vals;
    }
    /* 数组（B14）：`s[i] = v` 与 `m[i].y = v`。 */
    const ai = lhs.k === 'aindex' ? lhs
      : (lhs.k === 'swizzle' && lhs.of.k === 'aindex' ? lhs.of : null);
    if (ai !== null && ai.of.k === 'ref') {
      const b = this.varOf(ai.of.name);
      const w = llNComp(ai.ty);
      const lanes = [];
      if (lhs.k === 'aindex') for (let j = 0; j < w; j++) lanes.push(j);
      else for (const ix of lhs.idx) lanes.push(ix);
      if (ai.at.k === 'lit') {
        /* 常量下标：往那几格里写，一条掩码都不用多加。 */
        for (let li = 0; li < lanes.length; li++) {
          this.maskStore(b, ai.at.v * w + lanes[li], vals.length === 1 ? vals[0] : vals[li]);
        }
        return vals;
      }
      /* 变量下标：每个元素压一条 `idx == k`。这与「不落成内存」那一版的 select 链是
       * 同一个代价（每一格都要碰），只是现在它写在掩码这一层，与 `if` 同一个机制。 */
      const idx = this.toI(this.expr(ai.at)[0]);
      const outer = this.execMask;
      for (let k = 0; k < ai.of.ty.n; k++) {
        const eq = this.i1ToMask(this.emit(`icmp eq ${LL_I} ${idx.v}, ${llI(k).v}`, 'b'));
        this.execMask = outer === null ? eq
          : this.emit(`and ${LL_I} ${outer.v}, ${eq.v}`, 'm');
        for (let li = 0; li < lanes.length; li++) {
          this.maskStore(b, k * w + lanes[li], vals.length === 1 ? vals[0] : vals[li]);
        }
      }
      this.execMask = outer;
      return vals;
    }
    throw new OmniError('glsl/llvm: 这一片的左值只收名字、它的 swizzle、以及数组取一格');
  }

  /**
   * 片元入口。签名**只有两个指针**（驱动那一侧照这个声明）：
   *
   *   void glsl_frag8(ptr in, ptr out)
   *
   *   `in`  指向连着的 `<8 x float>`：`[x, y, uniform 的每一格…]`
   *   `out` 指向连着的四格（r/g/b/a）
   *
   * **为什么全走指针**：第一版把 `<8 x float>` 直接当参数传，结果读出来整体错位一格 ——
   * 32 字节向量在 AArch64 上不是原生寄存器类型（NEON 是 16 字节），它要拆成两个 q
   * 或者走内存，而「IR 里的 `<8 x float>` 参数」与「C 里的 `ext_vector_type(8)` 参数」
   * 在这一格上不必一致。指针没有这个问题：ABI 面只剩一个地址。
   * 入口多几条 `load` —— 一批 8 个像素，摊下来看不见。
   *
   * **缓冲一律是 `<8 x float>`**（驱动那侧就是 `float` 数组）。所以 int/bool 的 uniform
   * 在入口处要转一次 —— 那不是"表示的妥协"，是 ABI：驱动递进来的字节就是 float。
   */
  run() {
    const m = this.mod;
    if (m.stage !== 'frag') throw new OmniError('glsl/llvm: 这一片只收片元');
    if (m.outs.length !== 1) throw new OmniError(`glsl/llvm: 只收一个 out（给了 ${m.outs.length}）`);
    /* 用户函数不再是拦路虎 —— 它们**内联**（见 `inlineCall`），所以这儿只要求有 `main`。 */
    const mainFn = this.fnByName.get('main');
    if (mainFn === undefined) throw new OmniError('glsl/llvm: 没有 main');
    /* 形参**刻意不叫 `i`**：见 `builtin()` 里 `at` 上面那段（闭包捕获那条检查是按
     * 函数粒度 + 按名字判的）。 */
    const load = (slotIx) => {
      const p = slotIx === 0 ? '%in' : this.emit(`getelementptr ${LL_F}, ptr %in, i64 ${slotIx}`, 'f').v;
      return this.emit(`load ${LL_F}, ptr ${p}, align 4`, 'f');
    };
    let slot = 0;
    const x = load(slot++);
    const y = load(slot++);
    this.bind('gl_FragCoord', [x, y, llF(0), llF(1)]);
    for (const u of m.uniforms) {
      const cts = llCompTys(u.ty);
      const comps = [];
      for (let i = 0; i < llNComp(u.ty); i++) {
        const raw = load(slot++);
        comps.push(cts[i] === 'f' ? raw : cts[i] === 'i' ? this.toI(raw) : this.toB(raw));
      }
      this.bind(u.name, comps);
    }
    for (const c of m.consts) this.bind(c.name, this.expr(c.init));
    /* 模块级变量（B16 / 决策十第 5 步）：GLSL 里它**每个调用各一份**，所以它就是这一层的
     * 一个落点 —— 与局部量一模一样，只是绑在第 0 层，内联进来的函数也看得见。
     * 不带初值，所以初值是零（规范说未初始化的全局是 0）。 */
    const gvs = m.globals === undefined ? [] : m.globals;
    for (const gv of gvs) this.bindVar(gv.name, llCompTys(gv.ty), null);
    const o = m.outs[0];
    const on = llNComp(o.ty);
    const zeros = [];
    for (let i = 0; i < on; i++) zeros.push(llF(0));
    /* `out` 是**可变的**，所以它也是一个落点 —— 上一版把它当 SSA 值，于是
     * `if (…) fragColor = …` 要靠合并那一步才写得回去。 */
    this.bindVar(o.name, llCompTys(o.ty), zeros);
    /* `return` 那一层（`lp_exec_mask` 的 `ret_mask`）：`main` 里 `return;` 之后那些道
     * 就不再写 `out` 了 —— 靠掩码，不靠跳转。 */
    this.retPtr = this.maskPtr('ret');
    this.stmt(mainFn.body);
    /* 写回：四格连着存，都按 float 存（缓冲的类型是定的）。 */
    const vals = this.readName(o.name);
    for (let i = 0; i < on; i++) {
      const p = i === 0 ? '%out' : this.emit(`getelementptr ${LL_F}, ptr %out, i64 ${i}`, 'f').v;
      this.body.push(`  store ${LL_F} ${this.toF(vals[i]).v}, ptr ${p}, align 4`);
    }
    const decls = [...this.need].sort().map((f) => {
      const nArgs = LL_INTRIN2.has(f) ? 2 : 1;
      const ps = [];
      for (let i = 0; i < nArgs; i++) ps.push(LL_F);
      return `declare ${LL_F} @${f}.v${GLSL_LANES}f32(${ps.join(', ')})`;
    });
    return `; GLSL -> LLVM IR（${GLSL_LANES} 道 SoA，分量带类型 f32/i32/i1）—— ADR-0019 决策十\n`
      + `; in = [x, y, uniform 每一格…]；out = [r, g, b, a]，缓冲都是 ${LL_F}\n`
      + `; 可变量在 alloca 里、写过掩码（照 lp_exec_mask_store）—— mem2reg 会把大部分提回 SSA\n`
      + `define void @glsl_frag8(ptr %in, ptr %out) {\n`
      + `${this.allocas.join('\n')}\n${this.body.join('\n')}\n  ret void\n}\n\n`
      + `${decls.join('\n')}\n`;
  }
}

/** GLSL 的 checked 模块 -> 一份 `.ll` 文本（只含 `@glsl_frag8` 与它要的 declare）。 */
export function glslEmitLlvm(mod) {
  return new GlslLlvmEmitter(mod).run();
}
