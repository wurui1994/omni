/**
 * regalloc —— 线性扫描寄存器分配（通道表的倒数第三格，Go 的 `ssa/regalloc.go`）。
 *
 * 为什么这一格是"下一个能动时间的"：L2 量出来的账（ADR-0039 第 8 节）——
 * smallpt 上我们的原生 C 腿是 clang -O2 的 **7.0x**，而开满与机器无关的通道
 * （指令 -5.6%）**时间一点没动**。原因在 `arm64/from_mir.js` 的文件头上写着：
 * 「每个 MIR 值一个栈位，算之前 `ldr` 进来、算完 `str` 回去」。热路径每条运算夹着
 * 一对内存访问，少几条指令换不出时间来。
 *
 * MIR 这一层做线性扫描有个**别处没有的便宜**：值的活跃区间**就是 pc 区间，而且一定连续**。
 * 靠的是区域作用域那条规矩（`region.js`）：
 *   - 一个值的使用必须在定义**之后**（verifier：「用了还没定义的」）
 *   - 跨过 `END` 就不可见 ⇒ 两个分支里的值的 pc 区间**不可能相交**
 *   - 循环里定义的值在下一轮会重新定义，而区间只到本轮的最后一次使用
 * 所以不必先跑一整遍活跃性数据流（Go 那边要，因为它的块是任意 CFG）。
 *
 * 出的是**颜色**（一个小整数），不是机器寄存器号：哪个颜色落到哪个真寄存器由后端定 ——
 * arm64 与 x86_64 的被调用者保存集不是一回事，而"这两个值不能住同一个寄存器"这件事
 * 与架构无关。
 *
 * **只有一类颜色**（不分整数/浮点）。这不是偷懒，是量过两条后端的事实：
 * `arm64/from_mir.js` 与 `x64/from_mir.js` 都把**每个值当成一个八字节的位模式**
 * 放在通用寄存器/栈位上，浮点是用 `fmov`/`movq` 在算的时候搬进 FP 寄存器再搬回来
 * （`toFp`/`fromFp`、`movqToXmm`/`movqFromXmm`）。所以"一个值一个通用寄存器"就够，
 * 分两类反而会让两类的颜色在同一批真寄存器上撞。
 *
 * **只分配单字的标量**：i32/i64/bool/f32/f64/thin 指针。胖指针（T_PTR，三个字）、聚合、
 * 串、dyn、向量一律不碰 —— 它们在后端不是"一个寄存器"。
 */

import {
  OP, OP_MODES, REF_BIAS, REF_NONE,
  T_VOID, T_BOOL, T_I32, T_I64, T_F32, T_F64, T_TPTR,
  typeLanes, isCmp,
} from '../ir.js';
import { registerPass } from './pass.js';

/** 这个类型住得下一个通用寄存器吗（浮点也算 —— 后端拿它当八字节位模式，见文件头）。 */
function fitsOneWord(t) {
  if (typeLanes(t) !== 1) return false;          // 向量不是一个寄存器
  return t === T_I32 || t === T_I64 || t === T_BOOL || t === T_TPTR
      || t === T_F32 || t === T_F64;
}

/** 一条指令产出的值的类型（比较的结果是 bool，不是操作数的类型）。 */
function resultType(fn, pc) {
  return isCmp(fn.op[pc]) ? T_BOOL : fn.t[pc];
}

/** 每个值**最后一次被用**在哪条指令上（没人用回 -1）。 */
function lastUses(fn) {
  const last = [];
  for (let i = 0; i < fn.op.length; i++) last.push(-1);
  const see = (ref, at) => {
    if (ref === REF_NONE || ref < REF_BIAS) return;
    const d = ref - REF_BIAS;
    if (d >= 0 && d < last.length && at > last[d]) last[d] = at;
  };
  for (let pc = 0; pc < fn.op.length; pc++) {
    const m = OP_MODES[fn.op[pc]];
    if (m[0] === 'r') see(fn.a[pc], pc);
    if (m[1] === 'r') see(fn.b[pc], pc);
    if (m[1] === 'p') {
      const at = fn.b[pc];
      const n = fn.args[at];
      for (let i = 0; i < n; i++) see(fn.args[at + 1 + i], pc);
    }
  }
  return last;
}

/**
 * **循环那一刀**：把"定义在循环外、最后一次使用在循环里"的值的区间延长到那个循环的 `END`。
 *
 * 为什么非得有这一步（差点漏掉的一个真 bug）：区间 `[定义, 最后一次使用]` 在直线代码与
 * 分支上都对，但回边会把控制流送回循环头 —— 一个值在第二轮的 pc 15 还要用，而第一轮的
 * pc 20 已经把那个颜色给了别人。判据是：
 *
 *   x = …            (pc 5，循环外)
 *   LOOP
 *     … 用 x …       (pc 15，x 的"最后一次使用")
 *     y = …          (pc 20)  ← 区间 [20,25] 与 [5,15] 不交，会被涂成同色
 *     … 用 y …       (pc 25)
 *     BR ^0
 *   END              (pc 30)
 *
 * 所以 x 的区间要延到 30。这是线性扫描的标准做法（LSRA 那篇里叫"把区间延到循环末"），
 * Go 那边不需要它是因为它按真的 CFG 算活跃性。
 */
function extendForLoops(fn, last) {
  const n = fn.op.length;
  /* 一遍扫出：每条指令处**开着的 LOOP** 有哪些（栈，外层在前），与每个区域的 END 在哪儿 */
  const stack = [];                 // {pc, op}
  const openLoops = [];             // openLoops[pc] = 开着的 LOOP 的 pc 数组（共享同一份的拷贝）
  const endOf = [];
  for (let i = 0; i < n; i++) endOf.push(-1);
  const pending = [];
  for (let pc = 0; pc < n; pc++) {
    const op = fn.op[pc];
    if (op === OP.END && pending.length > 0) {
      const open = pending.pop();
      endOf[open] = pc;
      /* 与 stack 同步：END 关掉最近一个未关的区域 */
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].pc === open) { stack.splice(k, 1); break; }
      }
    }
    const loops = [];
    for (const s of stack) if (s.op === OP.LOOP) loops.push(s.pc);
    openLoops.push(loops);
    if (op === OP.BLOCK || op === OP.LOOP || op === OP.IF) {
      stack.push({ pc, op });
      pending.push(pc);
    }
  }

  for (let d = 0; d < n; d++) {
    const u = last[d];
    if (u < 0) continue;
    let ext = -1;
    for (const lp of openLoops[u]) {
      if (lp > d && endOf[lp] > ext) ext = endOf[lp];   // 定义在这个循环之前 ⇒ 要延
    }
    if (ext > last[d]) last[d] = ext;
  }
  return last;
}

/** 有几个颜色可用。取的是**两条腿都够**的那个数：
 *  arm64 的被调用者保存通用寄存器是 x19-x28（x28 被这一层当帧基址用掉），
 *  x86_64 是 rbx/rbp/r12-r15（rbp 当帧指针用掉）—— 于是 5 个。
 *
 * ⚠️ **与后端的约定**：颜色必须映到**被调用者保存**的寄存器。
 * 这一层给出的区间会**跨过调用点**（一个值定义在调用之前、用在调用之后是常事），
 * 而这一层刻意不在调用点上把它们切开 —— 那样就要发溢出/恢复，是另一格的事。
 * 后端把颜色映到调用者保存的寄存器 = 一次调用之后读到垃圾。序言里存、收场里取，
 * 这笔账归后端。 */
export const COLORS = 5;

/**
 * 跑 regalloc。**不改一条指令** —— 只往 `fn.regHint` 上挂一张
 * `下标 -> 颜色` 的表（`Map`），由后端消费。
 *
 * `regHint` 是**标注**，与 `MirFunc.local`/`globalRo` 那些同一种性质：
 * 不进 `bytes.js` 的哈希（那边按字段来，认不出多出来的属性）、不进 verifier、
 * 解释器一眼都不看。后端拿不到它就照旧「每个值一个栈位」，所以这一格永远是安全的。
 *
 * 回分到了几个值。
 */
export function regalloc(fn, _mod) {
  if (!fn || fn.op.length === 0) return 0;
  const last = extendForLoops(fn, lastUses(fn));

  const hint = new Map();
  let active = [];                 // 活着的区间：{end, color}
  const free = [];
  for (let i = 0; i < COLORS; i++) free.push(i);

  let n = 0;
  for (let pc = 0; pc < fn.op.length; pc++) {
    /* 一、到期的先还回池子（`end < pc` 的那些）—— 线性扫描的 expire 那一步 */
    const keep = [];
    for (const it of active) {
      if (it.end < pc) free.push(it.color); else keep.push(it);
    }
    active = keep;

    /* 二、这条指令产的值要不要一个寄存器 */
    const t = resultType(fn, pc);
    if (t === T_VOID) continue;
    const end = last[pc];
    if (end < 0) continue;                       // 没人用（deadcode 会收走）
    if (!fitsOneWord(t)) continue;
    if (free.length === 0) continue;             // 用光了 ⇒ 这个值照旧住栈位（= 溢出）
    free.sort((x, y) => x - y);                  // 取最小的颜色：两次编译要一样
    const color = free.shift();
    hint.set(pc, color);
    active.push({ end, color });
    n++;
  }

  fn.regHint = hint;
  return n;
}

registerPass('regalloc', regalloc);

/**
 * 判据用：这张分配表**自洽**吗。回一串错（空 = 干净）。
 *
 * 判的就是寄存器分配唯一的那条硬约束：**两个区间相交的值不许同色**。
 * 区间 = `[定义的 pc, 最后一次使用的 pc]`，这一层的正确性全靠它连续（见文件头）。
 */
export function checkRegHint(fn) {
  const errs = [];
  if (!fn.regHint || fn.regHint.size === 0) return errs;
  const last = extendForLoops(fn, lastUses(fn));
  const items = [];
  for (const [pc, color] of fn.regHint) items.push({ pc, end: last[pc], color });
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.color !== b.color) continue;
      const overlap = a.pc <= b.end && b.pc <= a.end;
      if (overlap) {
        errs.push(`${fn.name}: %${a.pc}[${a.pc}..${a.end}] 与 %${b.pc}[${b.pc}..${b.end}]`
          + ` 区间相交却同色（${a.color}）`);
      }
    }
  }
  return errs;
}
