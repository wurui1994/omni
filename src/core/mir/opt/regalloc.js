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
 * **两类颜色**（通用 / 浮点），照 Go 的 `ssacompile/regalloc.go:885 compatRegs`：
 * `t.IsFloat()` 的进 FpRegMask、别的进 GpRegMask。两套物理寄存器文件、两个独立的池子，
 * 出两张表（`fn.regHint` / `fn.regHintF`）。
 *
 * 曾经只有一类（"后端把每个值当八字节位模式放通用寄存器"），那是照着后端当时的实现写的，
 * 不是照 Go 写的 —— 代价在指令级对账里看得见：radiance 里 `fmov` 511 条、
 * 真的浮点运算只有 115 条，全是"搬进 FP 算完搬回来"。
 *
 * **只分配单字的标量**：i32/i64/bool/f32/f64/thin 指针。胖指针（T_PTR，三个字）、聚合、
 * 串、dyn、向量一律不碰 —— 它们在后端不是"一个寄存器"。
 */

import {
  OP, OP_MODES, REF_BIAS, REF_NONE, isConstRef,
  T_VOID, T_BOOL, T_I32, T_I64, T_F32, T_F64, T_TPTR,
  typeLanes, isCmp,
} from '../ir.js';
import { registerPass } from './pass.js';

/** 这个类型住得下一个寄存器吗（浮点也算 —— 它进的是另一套文件，见 `isFloatT`）。 */
function fitsOneWord(t) {
  if (typeLanes(t) !== 1) return false;          // 向量不是一个寄存器
  return t === T_I32 || t === T_I64 || t === T_BOOL || t === T_TPTR
      || t === T_F32 || t === T_F64;
}

/** 这个值该进**浮点那套寄存器文件**吗（照 Go 的 `compatRegs`：`t.IsFloat()`）。 */
function isFloatT(t) {
  return t === T_F32 || t === T_F64;
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
  const { openLoops, endOf } = scanRegions(fn);

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

/** 一遍扫出：每条指令处**开着的 LOOP** 有哪些（栈，外层在前），与每个区域的 END 在哪儿。 */
function scanRegions(fn) {
  const n = fn.op.length;
  const stack = [];                 // {pc, op}
  const openLoops = [];             // openLoops[pc] = 开着的 LOOP 的 pc 数组
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
  return { openLoops, endOf };
}

/**
 * **把标量槽位本身也涂色**（"槽位提升"）。
 *
 * 为什么这一格比再多涂几个值都值钱：MIR 里没有 phi，所以 mem2reg 在两条路汇合处
 * （`END`）只能取交 —— 循环携带的局部变量（归纳变量 `i`、累加器 `t`…）永远收不进
 * 值里，每一轮都是 `ldr` 进来、算完 `str` 回去。那对 `str`/`ldr` 是**跨迭代的内存
 * 依赖**（存转发要四五个周期，而且串行），比它多出来的两条指令贵得多。
 * 量出来的：`intersect` 的循环头每轮一条 `ldr x19,[sp,#0x20]`，而 go 的同一个循环
 * 把 `i` 放在 R0 里。
 *
 * 寄存器本身**就是汇合点** —— 所以这件事不需要 phi：只要一个槽的全部访问都是
 * `LOAD`/`STORE`（角色表里 `'s'` 只出现在这两条上，见 `ir.js` 的 `OP_MODES`），
 * 把它们换成寄存器读写，语义逐字相同。
 *
 * 资格（都是"判不准就不提升"）：
 *   - 槽的类型住得下一个寄存器（`fitsOneWord`）；
 *   - 每条 `LOAD` 的结果类型、每条 `STORE` 的值类型都**正好是槽的类型** ——
 *     宽度或整/浮不一致时寄存器里躺的位模式与栈位里的不是一回事；
 *   - 函数里没有 `SETJMP`：`longjmp` 会把被调用者保存的寄存器还原成 `setjmp` 那一刻的值，
 *     于是提升过的局部变量会莫名回退（C 说那是未定义的，但没必要自己踩）。
 *
 * 区间：`[第一次访问, 最后一次访问]`，再按"有访问落在某个循环里 ⇒ 整个循环都算活着"
 * 往外撑（值流过回边，见 `extendForLoops` 里那个判据的镜像）。形参的槽从 **-1** 开始 ——
 * 序言就把入参写进去了。
 */
function slotIntervals(fn, mod, openLoops, endOf) {
  const ns = fn.slots === undefined ? 0 : fn.slots.length;
  if (ns === 0) return new Map();
  const n = fn.op.length;
  const iv = new Map();
  const bad = new Set();
  const consts = (mod !== undefined && mod !== null && mod.consts !== undefined) ? mod.consts : null;
  for (let pc = 0; pc < n; pc++) {
    const o = fn.op[pc];
    if (o === OP.SETJMP) return new Map();
    if (o !== OP.LOAD && o !== OP.STORE) continue;
    const no = fn.aux[pc];
    if (!(no >= 0 && no < ns)) continue;
    const st = fn.slots[no].t;
    if (!fitsOneWord(st)) { bad.add(no); continue; }
    /* `STORE` 的值类型要真问一遍（`fn.t[pc]` 在 STORE 上有时是 void）。拿不到常量表时
     * （判据里有不带 mod 调这一格的）常量那一路就判不准 —— 判不准就不提升。 */
    let vt = null;
    if (o === OP.LOAD) vt = fn.t[pc];
    else if (consts !== null || !isConstRef(fn.a[pc])) vt = fn.typeOf(fn.a[pc], consts);
    if (vt !== st) { bad.add(no); continue; }
    let e = iv.get(no);
    if (e === undefined) { e = { start: pc, end: pc, float: isFloatT(st) }; iv.set(no, e); }
    e.end = pc;
    /* 有访问落在循环里 ⇒ 整个循环都算活着（回边会把值送回循环头） */
    for (const lp of openLoops[pc]) {
      if (lp < e.start) e.start = lp;
      if (endOf[lp] > e.end) e.end = endOf[lp];
    }
  }
  for (const no of bad) iv.delete(no);
  /* 形参的槽：序言就写进去了，从 -1 起算 */
  if (fn.params !== undefined) {
    for (const p of fn.params) {
      const e = iv.get(p.slot);
      if (e !== undefined) e.start = -1;
    }
  }
  return iv;
}

/** 有几个颜色可用。取的是**哪条腿最多**那个数：arm64 的被调用者保存通用寄存器是
 *  x19-x28，x28 被后端当帧基址用掉 ⇒ 9 个。x86_64 那条腿目前根本不消费 `regHint`，
 *  将来消费时它只有 rbx/r12-r15 5 个 —— 那边**认前 5 个颜色就够**，
 *  认不下的照旧住栈位（`stickyAt` 里 `c >= STICKY.length` 回 -1）。
 *
 *  所以这个数不是"两条腿的交集"：颜色是**上限**不是契约，后端少认几个永远是对的。
 *
 * ⚠️ **与后端的约定**：颜色必须映到**被调用者保存**的寄存器。
 * 这一层给出的区间会**跨过调用点**（一个值定义在调用之前、用在调用之后是常事），
 * 而这一层刻意不在调用点上把它们切开 —— 那样就要发溢出/恢复，是另一格的事。
 * 后端把颜色映到调用者保存的寄存器 = 一次调用之后读到垃圾。序言里存、收场里取，
 * 这笔账归后端。 */
export const COLORS = 9;

/**
 * **浮点那一类有几个颜色** —— arm64 的 d8-d15 在 AAPCS 里是被调用者保存的（低 64 位），
 * 一个都没别人占 ⇒ 8 个。
 *
 * 为什么要分两类（照 Go 的 `ssacompile/regalloc.go:885 compatRegs`）：
 *     if t.IsFloat() || t == types.TypeInt128 { m = s.f.Config.FpRegMask }
 *     else                                    { m = s.f.Config.GpRegMask }
 * 两个寄存器文件是两套物理寄存器，一个值该住哪套由**它的类型**定，不该挤在一个池子里抢。
 *
 * 这一刀的杠杆是指令级对账量出来的（radiance 3983 条指令）：
 *     mov 1047 / ldr 968 / str 748 / fmov 511 / add 442  —— 91.5% 是搬运
 *     真的浮点运算只有 fmul 67 + fadd 20 + fsub 20 + fdiv 8 = 115 条
 * 那 511 条 `fmov` 就是"浮点值住在通用寄存器里、算之前搬进 FP、算完搬回来"的账。
 * Go 那边同一个函数 FMOVD 只有 115 条，而且它的 FMOVD 连访存一起算在内 ——
 * 因为 Vec 的六个分量从头到尾住在 F0-F5 里。
 */
export const COLORS_F = 8;

/**
 * **浮点那一类还有多少个"只在不跨调用时能用"的颜色** —— arm64 有 32 个 FP 寄存器，
 * d8-d15 是被调用者保存的（上面 `COLORS_F`），**d16-d31 与 d0-d7 是调用者保存的**：
 * 一个活跃区间只要不跨过任何调用点，住在它们里头完全安全，而且序言/收场一个字都不用发。
 *
 * 为什么非加这一档不可（量出来的）：把 struct 拷贝改成按字段发之后，`Vec` 的分量不再
 * 以 i64 位模式流转、而是真的 f64 —— 于是**几乎所有值都要 FP 颜色**。
 * `radiance` 里该有寄存器的 550 个值中 429 个是浮点，而 FP 只有 8 个颜色：
 * 指令数从 1613 掉到 1283（-20%），时间却从 219ms 涨到 301ms。少的是搬运、多的是溢出。
 *
 * Go 的 `regalloc.go` 本来就分这两档（`regspec` 里每条指令的 `clobbers` 加
 * `s.freeUseRecords` 那一套）：跨调用的值它也只放被调用者保存的寄存器里。
 * 颜色的编号约定：`0 .. COLORS_F-1` 是被调用者保存的那 8 个，
 * `COLORS_F .. COLORS_F+COLORS_F_SCRATCH-1` 是草稿那一档 —— 后端按这个下标去 `STICKY_F`
 * 取真寄存器，**只有前 8 个要在序言里存**。
 */
export const COLORS_F_SCRATCH = 13;

/** 这条指令会踩掉调用者保存的寄存器吗（区间跨过它就不能住草稿那一档）。 */
function isCallOp(op) {
  return op === OP.CALL || op === OP.CALLI || op === OP.CCALL || op === OP.CALLFN
      || op === OP.SYSCALL;
}

/**
 * 跑 regalloc。**不改一条指令** —— 只往 `fn.regHint`（通用那一类）与 `fn.regHintF`
 * （浮点那一类）上各挂一张 `下标 -> 颜色` 的表（`Map`），由后端消费。
 *
 * 两张表**各自一套颜色**（`COLORS` / `COLORS_F`），因为它们映到两套物理寄存器文件。
 * 照 Go 的 `compatRegs`：类型是浮点的进 FpRegMask，别的进 GpRegMask。
 *
 * `regHint`/`regHintF` 是**标注**，与 `MirFunc.local`/`globalRo` 那些同一种性质：
 * 不进 `bytes.js` 的哈希（那边按字段来，认不出多出来的属性）、不进 verifier、
 * 解释器一眼都不看。后端拿不到它就照旧「每个值一个栈位」，所以这一格永远是安全的。
 *
 * 回分到了几个值（两类之和）。
 */
export function regalloc(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const last = extendForLoops(fn, lastUses(fn));
  const { openLoops, endOf } = scanRegions(fn);
  const slotIv = slotIntervals(fn, mod, openLoops, endOf);
  /* 槽位按区间起点分桶：到那个 pc 就跟值抢同一个池子（起点 -1 的在进循环之前先发）。 */
  const slotsAt = new Map();
  for (const [no, e] of slotIv) {
    const k = e.start;
    if (!slotsAt.has(k)) slotsAt.set(k, []);
    slotsAt.get(k).push(no);
  }

  /* 两个独立的池子：`cls[0]` 是通用、`cls[1]` 是浮点。
   * 浮点那一类的 `scratch` 是"只给不跨调用的区间"的那一档（见 `COLORS_F_SCRATCH`）。 */
  const cls = [
    { hint: new Map(), slotHint: new Map(), active: [], free: [], scratch: [] },
    { hint: new Map(), slotHint: new Map(), active: [], free: [], scratch: [] },
  ];
  for (let i = 0; i < COLORS; i++) cls[0].free.push(i);
  for (let i = 0; i < COLORS_F; i++) cls[1].free.push(i);
  for (let i = 0; i < COLORS_F_SCRATCH; i++) cls[1].scratch.push(COLORS_F + i);

  /* 每条指令之前有几个调用点（前缀和）—— 区间 [s,e] 跨调用 ⇔ 这两端的计数不同。 */
  const callsBefore = [];
  {
    let c = 0;
    for (let pc = 0; pc < fn.op.length; pc++) { callsBefore.push(c); if (isCallOp(fn.op[pc])) c++; }
    callsBefore.push(c);
  }
  const crossesCall = (s, e) => {
    const a = callsBefore[s < 0 ? 0 : s];
    const b = callsBefore[e + 1 >= callsBefore.length ? callsBefore.length - 1 : e + 1];
    return b !== a;
  };

  /** 给一个区间要个颜色。要不到就抢一个**值**（槽位不当牺牲品：它的住处是全函数
   *  一个决定，中途换人后端没法表达）。回真给了没有。 */
  const grant = (c, key, end, isSlot, operandOf, start) => {
    /* 不跨调用的先吃草稿那一档（调用者保存的寄存器，序言一个字都不用发）。 */
    if (c.scratch.length > 0 && !crossesCall(start, end)) {
      c.scratch.sort((x, y) => x - y);
      const color = c.scratch.shift();
      (isSlot ? c.slotHint : c.hint).set(key, color);
      c.active.push({ pc: key, end, color, slot: isSlot, scratch: true });
      return true;
    }
    if (c.free.length === 0) {
      let worst = -1, worstEnd = isSlot ? -1 : end;
      for (let k = 0; k < c.active.length; k++) {
        const it = c.active[k];
        if (it.slot === true) continue;                   // 槽位不许被抢
        if (it.scratch === true) continue;                // 草稿那一档不参与（它没占 free）
        if (operandOf !== null && operandOf.has(it.pc)) continue;
        if (it.end > worstEnd) { worstEnd = it.end; worst = k; }
      }
      if (worst < 0) return false;
      const victim = c.active[worst];
      c.hint.delete(victim.pc);
      c.active.splice(worst, 1);
      (isSlot ? c.slotHint : c.hint).set(key, victim.color);
      c.active.push({ pc: key, end, color: victim.color, slot: isSlot });
      return true;
    }
    c.free.sort((x, y) => x - y);                // 取最小的颜色：两次编译要一样
    const color = c.free.shift();
    (isSlot ? c.slotHint : c.hint).set(key, color);
    c.active.push({ pc: key, end, color, slot: isSlot });
    return true;
  };

  const grantSlots = (pc) => {
    const list = slotsAt.get(pc);
    if (list === undefined) return;
    for (const no of list) {
      const e = slotIv.get(no);
      grant(cls[e.float ? 1 : 0], no, e.end, true, null, e.start);
    }
  };

  let n = 0;
  grantSlots(-1);
  for (let pc = 0; pc < fn.op.length; pc++) {
    /* 一、到期的先还回各自的池子（`end < pc` 的那些）—— 线性扫描的 expire 那一步 */
    for (const c of cls) {
      const keep = [];
      for (const it of c.active) {
        if (it.end < pc) (it.scratch === true ? c.scratch : c.free).push(it.color);
        else keep.push(it);
      }
      c.active = keep;
    }
    /* 二、这个 pc 起活的槽位先要（它们的区间最长、在循环里，比单个值值钱） */
    grantSlots(pc);

    /* 三、这条指令产的值要不要一个寄存器 */
    const t = resultType(fn, pc);
    if (t === T_VOID) continue;
    const end = last[pc];
    if (end < 0) continue;                       // 没人用（deadcode 会收走）
    if (!fitsOneWord(t)) continue;
    /* 这条指令的操作数是哪几条指令产的（抢占时要避开，见 `grant`）。 */
    const operandOf = new Set();
    {
      const m = OP_MODES[fn.op[pc]];
      const add = (ref) => { if (ref !== REF_NONE && ref >= REF_BIAS) operandOf.add(ref - REF_BIAS); };
      if (m[0] === 'r') add(fn.a[pc]);
      if (m[1] === 'r') add(fn.b[pc]);
      if (m[1] === 'p') {
        const at = fn.b[pc];
        const cnt = fn.args[at];
        for (let i = 0; i < cnt; i++) add(fn.args[at + 1 + i]);
      }
    }
    const c = cls[isFloatT(t) ? 1 : 0];
    /**
     * **池子用光了 ⇒ 抢一个**（Go 的 `ssa/regalloc.go` 文件头：
     * 「spills registers only when necessary, and spills the value whose next use is
     * farthest in the future」）。在这一层"下次使用最远"就是**区间的右端最远**
     * （我们的区间是 `[定义, 最后一次使用]`、连续，见文件头）。被抢的那个从表里摘掉
     * （没颜色 = 照旧住栈位，这一层的"溢出"就是这么便宜）。
     *
     * 为什么非要这一条：从前是"先到先得、用光就不给了"。量出来的（`OMNI_RA_STAT=1`）：
     * `scene` 同时活着 19 个、我们只有 9+8=17 个颜色，覆盖率只有 79.9% ——
     * 先到先得会让一个横跨整个函数的长区间白占一个颜色，挤掉后面十几个短命但在热循环里的值。
     */
    if (grant(c, pc, end, false, operandOf, pc) && c.hint.has(pc)) n++;
  }

  fn.regHint = cls[0].hint;
  fn.regHintF = cls[1].hint;
  fn.slotHint = cls[0].slotHint;
  fn.slotHintF = cls[1].slotHint;
  /* `OMNI_RA_STAT=1`：印出这一格的覆盖率与压力 —— 「同时活着最多几个」决定了
   * 加寄存器还不还得起，「分到几个」决定了抢占策略有没有用。量过再改，别猜。 */
  if (process.env.OMNI_RA_STAT === '1' && fn.op.length >= 200) {
    let want = 0, maxLive = 0, live = 0;
    const evt = [];
    for (let pc = 0; pc < fn.op.length; pc++) {
      if (last[pc] < 0) continue;
      const t = resultType(fn, pc);
      if (t === T_VOID || !fitsOneWord(t)) continue;
      want++;
      evt.push([pc, 1], [last[pc] + 1, -1]);
    }
    evt.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, d] of evt) { live += d; if (live > maxLive) maxLive = live; }
    const got = cls[0].hint.size + cls[1].hint.size;
    process.stderr.write(`[ra] ${fn.name}: ${fn.op.length} 条指令，该有寄存器的值 ${want} 个，`
      + `分到 ${cls[0].hint.size}+${cls[1].hint.size}=${got}`
      + `（${(100 * got / Math.max(1, want)).toFixed(1)}%），同时活着最多 ${maxLive} 个\n`);
  }
  return n;
}

registerPass('regalloc', regalloc);

/**
 * 判据用：这两张分配表**自洽**吗。回一串错（空 = 干净）。
 *
 * 判的就是寄存器分配唯一的那条硬约束：**两个区间相交的值不许同色**。
 * 区间 = `[定义的 pc, 最后一次使用的 pc]`，这一层的正确性全靠它连续（见文件头）。
 * 两类各自判：通用与浮点是两套物理寄存器，跨类同色不冲突。
 */
export function checkRegHint(fn, mod) {
  const errs = [];
  const last = extendForLoops(fn, lastUses(fn));
  const { openLoops, endOf } = scanRegions(fn);
  const slotIv = slotIntervals(fn, mod, openLoops, endOf);
  for (const [cls, hint, sh] of [['通用', fn.regHint, fn.slotHint], ['浮点', fn.regHintF, fn.slotHintF]]) {
    const items = [];
    if (hint && hint.size > 0) {
      for (const [pc, color] of hint) items.push({ what: `%${pc}`, pc, end: last[pc], color });
    }
    if (sh && sh.size > 0) {
      for (const [no, color] of sh) {
        const e = slotIv.get(no);
        if (e === undefined) { errs.push(`${fn.name}（${cls}）: slot${no} 涂了色可是没有区间`); continue; }
        items.push({ what: `slot${no}`, pc: e.start, end: e.end, color });
      }
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.color !== b.color) continue;
        const overlap = a.pc <= b.end && b.pc <= a.end;
        if (overlap) {
          errs.push(`${fn.name}（${cls}）: ${a.what}[${a.pc}..${a.end}] 与`
            + ` ${b.what}[${b.pc}..${b.end}] 区间相交却同色（${a.color}）`);
        }
      }
    }
  }
  return errs;
}
