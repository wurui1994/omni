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
import { mem2reg } from './ssa.js';
import { registerPass } from './pass.js';

/** 预算：被调的指令条数上限。Go 那边是 `inlineMaxBudget = 80`（`inline/inl.go`）——
 *  它数的是 AST 的"复杂度分"，我们数 MIR 指令条数，取同一个量级。 */
export const INLINE_MAX = 80;
/** 一趟最多展开多少处。Go **没有这个闸**（它只看被调的成本），这儿留一个大数只为
 *  「一趟别抄出个几万条」的兜底 —— 真正的闸是 `inlinePass` 那一层的长胖倍数。 */
export const INLINE_MAX_SITES = 4096;

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
    /* 2.3 结果槽（void 就不要；尾返回那一路也不要 —— 见下面 `tailRet`） */
    const ctx = { callee, slotBase, frameBase, cmap: [] };
    for (let q = 0; q < callee.op.length; q++) ctx.cmap.push(-1);

    /**
     * **尾返回：不包 BLOCK、不要结果槽。**
     *
     * 条件（三条都要）：被调只有一条 `RET`、它在**最后一条**、而且那儿**没开着任何区域**。
     * `vsub`/`vdot`/`V` 这种一句 return 的函数全满足。
     *
     * 为什么这一刀现在值钱了（之前量过一次是**负收益**，注释留在文件末尾）：
     * 那时 `ssa.js` 的 `addressTakenSlots` 有一行「函数里有 FRAME 就把所有槽标成地址已取」，
     * **mem2reg 在这些函数上整个是空操作**，所以包不包 BLOCK 只影响后端那五个 POOL 寄存器
     * 的活跃区间，包着反而好。那一行改掉之后账翻过来了：包着 BLOCK 的话
     *   `STORE 结果 -> 槽`（在 BLOCK 里）+ `LOAD 槽`（在 END 之后）
     * 跨了区域边界，MIR 没有 phi、`region.js` 那条词法作用域的规矩下 mem2reg **提升不掉** ——
     * 每个内联的 `vsub` 都留下一对访存。不包就没有那道边界。
     */
    let tailRet = -1;
    {
      /* 从末尾往前吃连着的 `RET`，同时算它们那儿开着几层区域。
         C 前端常在末尾铺**两条一样的 `RET`**（一条来自源码里的 return、一条是兜底的），
         后一条到不了 —— 所以判据不是"只有一条 RET"，而是**所有 RET 连成一个后缀、
         都在 0 层、而且带的是同一个值**。那样第一条就是唯一会执行的那条。 */
      const depthAt = [];
      let d = 0;
      for (let q = 0; q < callee.op.length; q++) {
        const cop = callee.op[q];
        if (cop === OP.END) d--;
        depthAt.push(d);
        if (cop === OP.BLOCK || cop === OP.LOOP || cop === OP.IF) d++;
      }
      let q = callee.op.length;
      while (q > 0 && callee.op[q - 1] === OP.RET && depthAt[q - 1] === 0) q--;
      if (q > 0 && q < callee.op.length) {
        let same = true;
        for (let k = q; k < callee.op.length; k++) {
          if (callee.a[k] !== callee.a[q]) { same = false; break; }
          if (callee.op[k] !== OP.RET) { same = false; break; }
        }
        /* 中间不能还有别的 `RET`（那种是真的多出口，得包 BLOCK） */
        for (let k = 0; k < q; k++) if (callee.op[k] === OP.RET) { same = false; break; }
        if (same) tailRet = q;
      }
    }
    const resSlot = (callee.ret === T_VOID || tailRet >= 0)
      ? -1 : fn.slot(`${callee.name}$ret`, callee.ret);

    if (tailRet >= 0) {
      /* 2.4a 尾返回：整段直接铺进来，那条 `RET` 一个字都不发 */
      for (let q = 0; q < tailRet; q++) {
        ctx.cmap[q] = emit(callee.op[q], callee.t[q], callee.a[q], callee.b[q], callee.aux[q],
          { ctx, oldPc: q, ret: false });
      }
      /* 2.5a 顶替那条 CALL：就是 `RET` 带的那个值（void 的就映到最后一条） */
      const rv = callee.a[tailRet];
      if (callee.ret === T_VOID || rv === REF_NONE) {
        map[pc] = REF_BIAS + (op.length - 1);
      } else if (rv < REF_BIAS) {
        map[pc] = rv;                                  // 常量：照原样
      } else {
        map[pc] = REF_BIAS + ctx.cmap[rv - REF_BIAS];  // 被调体里那条指令的新下标
      }
      continue;
    }

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
  /**
   * ---- 四、**把新造的那些槽位再提升一遍**（`mem2reg`）。
   *
   * 这不是多加一格优化，是补上 Go 免费拿到的那一步：Go 在 SSA **之前**内联
   * （`internal/inline.InlineDecls`），所以它建 SSA 的时候看见的已经是内联完的函数体，
   * 被内联进来的形参/局部/返回值在那一步就成了值。我们在 MIR 上内联、而 mem2reg
   * （通道表第二格 `early phielim and copyelim`）早就跑过了，不补这一步的话
   * 上面 `emit(OP.STORE, …)` 给每个形参造的槽位一个都提升不掉。
   *
   * 代价是量出来的：不补时 `sph_intersect`（smallpt 自时间 47%）里的
   * `%46 ADD %21 k4` -> `STORE slot9` 让那个帧块看起来"逃逸"了，
   * `copyfwd.js` 与 `sroa.js` 两格都不敢动它。
   */
  mem2reg(fn, mod);
  return sites.size;
}

/** 通道表里 `inline` 那一格（**我们加的，Go 的表里没有** —— 它在 SSA 之前就内联完了）。
 *  位置在 `decompose user` 之前，`PASS_ORDER` 上有这一对约束。
 *
 * **跑到不动点**，因为 Go 就是那样：它按调用图**自底向上**内联
 * （`inline.InlineDecls` 先处理被调、再处理调用者），所以 `radiance` 内联 `vnorm` 时
 * 抄进来的那一份**里头的 `vsub`/`vdot` 已经是展开好的**。我们一趟只展开当前函数体里
 * 看得见的那些调用点，抄进来的被调体里还留着它自己的调用 —— 不再跑一趟就停在半路。
 *
 * 闸也照 Go：**唯一的硬闸是被调的成本**（`inlineMaxBudget = 80`，见 `INLINE_MAX`），
 * 不是"一个函数最多展开几处"。从前 `INLINE_MAX_SITES = 24` 那个闸量出来正好把
 * `radiance` 卡在半路：可内联的调用点展开了 24 个，剩下
 * `vmul×8 vadd×4 vdot×4 vsub×3 vmult×3 vnorm×1` 共 23 处 —— 每一处都拖着一个
 * `ARGMEM`/`ARGSRET` 帧块，而帧块的地址被取了，`sroa.js` 与 `copyfwd.js` 两格
 * 就都判它逃逸、一条访存都收不掉。radiance 因此留着 156 条 `MSTORE i64`
 * （按字节搬 struct），而 go 的同一个函数一条访存都没有（三个分量住 F 寄存器）。
 *
 * 轮数的闸是**长胖多少**（`INLINE_MAX_GROWTH` 倍）：一趟没长就停，长过头也停。 */
export const INLINE_MAX_GROWTH = 12;

function inlinePass(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const start = fn.op.length;
  let total = 0;
  for (;;) {
    const k = inlineCalls(fn, mod);
    if (k === 0) break;
    total += k;
    if (fn.op.length > start * INLINE_MAX_GROWTH) break;
  }
  return total;
}

registerPass('inline', inlinePass);

/* 试过、量过、**退回来**的那一样（记在这儿，别再重来一遍）：
 *
 * 一、~~尾返回不包 BLOCK~~ —— **这一条作废了，现在就是这么做的**（见上面 `tailRet`）。
 *     当时量出来 890 -> 985ms（负收益），结论是"包着那层 BLOCK 反而快"，理由记的是
 *     "整段成了直线代码、活跃区间拉长、POOL 反复写回栈位"。那个结论是**错的判据下的**：
 *     那时 `ssa.js` 的 `addressTakenSlots` 有一行「函数里有 FRAME 就把所有槽标成地址已取」，
 *     **mem2reg 在这些函数上整个是空操作**，所以包不包 BLOCK 只影响后端 POOL 的活跃区间。
 *     那一行改掉之后，包 BLOCK 的代价（`STORE 结果->槽` 与 `LOAD 槽` 跨区域边界、
 *     mem2reg 提升不掉、槽的地址还让逃逸判定误判整块）就露出来了：
 *     不包之后 414 -> 302ms（×3.44 -> ×2.51）。
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
