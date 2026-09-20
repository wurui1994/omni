/**
 * inline —— 把小函数在调用点展开。**这一格是那个杠杆**（ADR-0039 第 8 节的第三条）。
 *
 * 为什么是它：原生腿 `radiance` 过完管线 732 条指令里，
 * `ARGMEM 76 + ARGSRET 45 + CALL 62 = 183`（25%）全是**按值传 struct 的调用约定**，
 * 访存又占 45%。clang -O2 用的是同一套 ABI，差别只是把 `add`/`mul`/`norm` 那几个
 * `static` 内联了 —— 边界一消失，那 25% 与大半访存一起没了，接着 SROA/mem2reg/regalloc
 * 才有得可做（第 3 节那条三步流水的次序：**内联 → SROA → mem2reg → regalloc**）。
 *
 * Go 在**SSA 之前**就内联完了（`internal/inline.InlineDecls`，前端的事），所以它的
 * 通道表里没有这一格。我们没有那一层，就落在 MIR 上 —— 判据照它：按**成本**挑
 * （`inline.go` 的 `hairyVisitor` + 预算），不动递归。
 *
 * 形状（MIR 是结构化控制流，所以 `RET` 要翻成"带值跳出去"）
 * ------------------------------------------------------
 *   CALL f (a0 a1)                 =>   STORE a0 -> 形参槽0
 *                                       STORE a1 -> 形参槽1
 *                                       BLOCK                     ← 包一层
 *                                         …被调的函数体（ref/槽/帧全重编号）…
 *                                         RET v  =>  STORE v -> 结果槽; BR ^d
 *                                       END
 *                                       LOAD 结果槽                ← 顶替原来那条 CALL
 *
 * `BR ^d` 的 `d` = 那条 `RET` 在被调函数体里**当时开着几层区域** —— 包的那一层 BLOCK
 * 正好在它们外面第 d 层（wasm 的层数语义，与 `cfg.js` 的 `brTarget` 同一套）。
 *
 * 同一个模块里内联省掉一大摊重映射：常量、全局号、类型号、函数号、C_ABI 入口号
 * 都是**模块级**的，一个字不用改。要改的只有三样：指令 ref、槽号、帧块号。
 *
 * 不碰的那些（一条都不许猜）
 * ------------------------
 *   - 递归（被调 = 调用者）、`extern`/`decl`（没函数体）、变参
 *   - 被调里有：`SPGET/SPSET/SPALLOC`（会动栈顶）、`VASTART/VAARG/VACOPY`、
 *     `SETJMP/LONGJMP`、`FPGET`（帧指针，只在那个函数的帧上有意义）
 *   - 实参个数与形参个数对不上
 *   - 只认 `CALL`（直接调用）：`CALLFN`/`CALLI` 得先 devirt，`CCALL` 是别人的 ABI
 */

import { OP, OP_MODES, REF_BIAS, REF_NONE, T_VOID } from '../ir.js';
import { registerPass } from './pass.js';

/** 预算：被调的指令条数上限。Go 那边是 `inlineMaxBudget = 80`（`inline/inl.go`）——
 *  它数的是 AST 的"复杂度分"，我们数 MIR 指令条数，取同一个量级。 */
export const INLINE_MAX = 80;
/** 一个函数最多展开多少处（免得一趟把函数吹成几千条）。 */
export const INLINE_MAX_SITES = 24;

/** 被调里有这些 op 就不内联 —— 它们的意义绑在"那个函数自己的帧/ABI"上。 */
function bodyOk(fn) {
  for (let pc = 0; pc < fn.op.length; pc++) {
    const op = fn.op[pc];
    if (op === OP.SPGET || op === OP.SPSET || op === OP.SPALLOC
        || op === OP.VASTART || op === OP.VAARG || op === OP.VACOPY
        || op === OP.SETJMP || op === OP.LONGJMP || op === OP.FPGET) return false;
  }
  return true;
}

/** 这个被调函数能内联吗。 */
function callable(callee, caller) {
  if (callee === undefined || callee === caller) return false;
  if (callee.extern === true || callee.decl === true) return false;
  if (callee.variadic === true) return false;
  if (callee.op.length === 0 || callee.op.length > INLINE_MAX) return false;
  return bodyOk(callee);
}

/**
 * 跑 inline。回展开了几处。
 *
 * **一趟重建**：先挑好调用点，再从头把指令抄一遍（选中的那几处摊开），
 * 最后按 `map` 把所有 ref 改一遍。插指令这件事只能这么做 —— 指令下标就是 ref。
 */
export function inlineCalls(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;

  /* ---- 一、挑调用点 */
  const sites = new Map();          // 调用点 pc -> 被调的 MirFunc
  for (let pc = 0; pc < fn.op.length && sites.size < INLINE_MAX_SITES; pc++) {
    if (fn.op[pc] !== OP.CALL) continue;
    const callee = mod.funcs[fn.a[pc]];
    if (!callable(callee, fn)) continue;
    const args = argRefs(fn, fn.b[pc]);
    if (args.length !== callee.params.length) continue;
    sites.set(pc, callee);
  }
  if (sites.size === 0) return 0;

  /* ---- 二、一趟重建 */
  const old = { op: fn.op, t: fn.t, a: fn.a, b: fn.b, aux: fn.aux };
  const n = old.op.length;
  /* 老下标 -> **新的 ref**（不是下标）：尾返回那一路调用点可能直接映到一个**常量**，
     而常量没有下标。-1 = 还没定。 */
  const map = [];
  for (let i = 0; i < n; i++) map.push(-1);
  const op = [], t = [], a = [], b = [], aux = [];
  /* 内联进来的指令：`{from}` 记它是被调的第几条（第二遍按它改 ref） */
  const inFrom = [];                // 新下标 -> {callee, oldPc, slotBase, frameBase} 或 null
  const emit = (o, ty, x, y, ax, from) => {
    op.push(o); t.push(ty); a.push(x); b.push(y); aux.push(ax); inFrom.push(from === undefined ? null : from);
    return op.length - 1;
  };

  for (let pc = 0; pc < n; pc++) {
    const callee = sites.get(pc);
    if (callee === undefined) {
      map[pc] = REF_BIAS + emit(old.op[pc], old.t[pc], old.a[pc], old.b[pc], old.aux[pc]);
      continue;
    }
    /* 2.1 给被调的槽位与帧块在调用者里各开一份 */
    const slotBase = fn.slots.length;
    for (const s of callee.slots) fn.slots.push({ name: `${callee.name}$${s.name}`, t: s.t });
    const frameBase = fn.frames.length;
    for (const f of callee.frames) {
      fn.frames.push({ name: `${callee.name}$${f.name}`, size: f.size, align: f.align });
    }
    /* 2.2 实参落进形参槽（**按老的 ref 写，第二遍再改**）
     *
     * `ARGMEM`/`ARGSRET` 要**剥一层**：它们是"按值传/返回 struct"那套 ABI 的摆法，
     * 值是一整块字节；而被调那一侧的形参槽里装的是**那一块的地址**
     * （`arm64/from_mir.js` 的形参那段：C.10/C.13 一律「槽里放它的地址」）。
     * 所以塞进槽里的是 `a`（那一块的地址），不是这条 ARGMEM 自己。
     * 那一块本来就是调用方为"形参是实参的一份可改的拷贝"造的临时块（前端的
     * `structCopy`），所以被调者照旧可以随便改它。 */
    const args = argRefs(fn, old.b[pc]);
    for (let i = 0; i < args.length; i++) {
      const p = callee.params[i];
      let v = args[i];
      if (v !== REF_NONE && v >= REF_BIAS) {
        const vop = old.op[v - REF_BIAS];
        if (vop === OP.ARGMEM || vop === OP.ARGSRET) v = old.a[v - REF_BIAS];
      }
      emit(OP.STORE, p.t, v, REF_NONE, slotBase + p.slot);
    }
    /* 2.3 结果槽（void 就不要） */
    const resSlot = callee.ret === T_VOID ? -1 : fn.slot(`${callee.name}$ret`, callee.ret);
    const ctx = { callee, slotBase, frameBase, cmap: [] };
    for (let q = 0; q < callee.op.length; q++) ctx.cmap.push(-1);

    /* 2.4 包一层 BLOCK，`RET` 翻成"存结果 + 跳出去" */
    emit(OP.BLOCK, T_VOID, REF_NONE, REF_NONE, 0);
    let depth = 0;                  // 被调体内当时开着几层
    for (let q = 0; q < callee.op.length; q++) {
      const cop = callee.op[q];
      if (cop === OP.END) depth--;
      if (cop === OP.RET) {
        if (resSlot >= 0 && callee.a[q] !== REF_NONE) {
          emit(OP.STORE, callee.ret, callee.a[q], REF_NONE, resSlot, { ctx, oldPc: q, ret: true });
        }
        ctx.cmap[q] = emit(OP.BR, T_VOID, REF_NONE, REF_NONE, depth);
        continue;
      }
      ctx.cmap[q] = emit(cop, callee.t[q], callee.a[q], callee.b[q], callee.aux[q],
        { ctx, oldPc: q, ret: false });
      if (cop === OP.BLOCK || cop === OP.LOOP || cop === OP.IF) depth++;
    }
    emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
    /* 2.5 顶替原来那条 CALL：读结果槽（void 的话就映到那条 END） */
    map[pc] = REF_BIAS + (resSlot >= 0
      ? emit(OP.LOAD, callee.ret, REF_NONE, REF_NONE, resSlot)
      : op.length - 1);
  }

  fn.op = op; fn.t = t; fn.a = a; fn.b = b; fn.aux = aux;
  /* ---- 三、按角色改 ref / 槽号 / 帧块号；池子该抄的抄 */
  fixRefs(fn, map, inFrom, mod);
  /* 分配表按下标记的，已经作废 */
  if (fn.regHint !== undefined) fn.regHint = undefined;
  if (fn.regHintF !== undefined) fn.regHintF = undefined;
  return sites.size;
}

/** 通道表里 `inline` 那一格（**我们加的，Go 的表里没有** —— 它在 SSA 之前就内联完了）。
 *  位置在 `decompose user` 之前，`PASS_ORDER` 上有这一对约束。 */
registerPass('inline', inlineCalls);

/* 试过、量过、**退回来**的两样（记在这儿，别再重来一遍）：
 *
 * 一、**尾返回不包 BLOCK**。被调只有一个返回点且在末尾时，可以不包那层 BLOCK、不要结果槽，
 *     把调用点直接映到"被调返回的那个 ref"。指令少了（smallpt 4901 -> 4257 条），
 *     可**时间反而差**：890ms -> 985ms（×0.82 变 ×0.91）。原因与 `cost.js` 里那条同一个 ——
 *     没了那层 BLOCK，整段内联体成了一大段直线代码，值的活跃区间全拉长，后端那五个
 *     调用者保存的寄存器（`POOL`）反复写回栈位。**包着那层 BLOCK 反而快。**
 *
 * 二、**展开完紧跟一遍 mem2reg + deadcode**（"先内联、再建 SSA"那个直觉）。
 *     量出来一点不动（985ms vs 984ms）。形参那几条 `STORE 槽` 与被调体之间隔着那层 BLOCK
 *     （是个屏障），mem2reg 照 `cost.js` 的判据本来就不肯转发。
 *
 * 这两条合起来说明一件事：**这一层的收益已经卡在后端的寄存器分配上**，不在"再合并一点"。 */

/** 读一个实参池里那一串 ref（池是自描述的，见 ir.js）。 */
function argRefs(fn, at) {
  const n = fn.args[at];
  const out = [];
  for (let i = 0; i < n; i++) out.push(fn.args[at + 1 + i]);
  return out;
}

/**
 * 第二遍：把所有 ref / 槽号 / 帧块号改对，池子该抄的抄。
 *
 * 两套 ref 空间：调用者自己那些指令按 `map`（老下标 -> 新下标）改；内联进来的那些按
 * 它那一处的 `ctx.cmap`（被调的下标 -> 新下标）改。区分靠 `inFrom[pc]`。
 */
function fixRefs(fn, map, inFrom, mod) {
  const n = fn.op.length;
  const mapCaller = (ref) => {
    if (ref === REF_NONE || ref < REF_BIAS) return ref;
    const j = map[ref - REF_BIAS];
    if (j < 0) throw new Error(`mir/opt/inline: 调用者的 %${ref - REF_BIAS} 没有落点`);
    return j;                          // map 里存的已经是 ref（可能是个常量）
  };
  const mapCallee = (ref, ctx) => {
    if (ref === REF_NONE || ref < REF_BIAS) return ref;
    const j = ctx.cmap[ref - REF_BIAS];
    if (j < 0) throw new Error(`mir/opt/inline: ${ctx.callee.name} 的 %${ref - REF_BIAS} 没有落点`);
    return j + REF_BIAS;
  };
  const donePools = new Set();
  for (let pc = 0; pc < n; pc++) {
    const from = inFrom[pc];
    const m = OP_MODES[fn.op[pc]];
    if (from === null) {
      /* 调用者自己的（含我给形参写的那几条 STORE：它们的 a 是调用者的 ref） */
      if (m[0] === 'r') fn.a[pc] = mapCaller(fn.a[pc]);
      if (m[1] === 'r') fn.b[pc] = mapCaller(fn.b[pc]);
      if (m[1] === 'p') {
        const at = fn.b[pc];
        if (!donePools.has(at)) {
          donePools.add(at);
          const cnt = fn.args[at];
          for (let i = 0; i < cnt; i++) fn.args[at + 1 + i] = mapCaller(fn.args[at + 1 + i]);
        }
      }
      continue;
    }
    /* 内联进来的 */
    const ctx = from.ctx;
    const callee = ctx.callee;
    if (from.ret) { fn.a[pc] = mapCallee(fn.a[pc], ctx); continue; }   // 我造的那条 STORE
    if (m[0] === 'r') fn.a[pc] = mapCallee(fn.a[pc], ctx);
    if (m[1] === 'r') fn.b[pc] = mapCallee(fn.b[pc], ctx);
    if (m[1] === 'p' || m[1] === 'j') {
      /* 池子在**被调那一份**的 args 里，抄进调用者的池（'p' 里是 ref 要改，'j' 里是层数） */
      const at = fn.b[pc];
      const cnt = callee.args[at];
      const vals = [];
      for (let i = 0; i < cnt; i++) {
        const v = callee.args[at + 1 + i];
        vals.push(m[1] === 'p' ? mapCallee(v, ctx) : v);
      }
      fn.b[pc] = fn.pushArgs(vals);
    }
    /* 槽号与帧块号各自偏移。`FRAME` 的 aux 是**帧块号**（角色也是 'n'），单独一条。 */
    if (m[2] === 's') fn.aux[pc] = ctx.slotBase + fn.aux[pc];
    else if (fn.op[pc] === OP.FRAME) fn.aux[pc] = ctx.frameBase + fn.aux[pc];
  }
}
