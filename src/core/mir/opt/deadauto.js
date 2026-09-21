/**
 * dead auto elim —— 照 Go 的 `ssacompile/deadstore.go:246 elimDeadAutosGeneric`。
 *
 * 管的是**被取过地址**的局部量（auto）：追那个地址的值流，如果它只流到「写」上面、
 * 从来没被读过、也没跑到别处去，就把那些写全删了。
 *
 * 为什么现在这一格能起作用了（`autos.js` 文件末尾那段预言的第一件事）
 * -------------------------------------------------------------
 * 那段写着：这一格要起作用得等「native 那条腿上局部量走 `FRAME`，那时基址不进任何全局，
 * Go 的判据原样可用」。native 腿本来就是那样（`FRAME` 给出真地址，没有影子栈），
 * 而按值收发 struct 的那些临时块正是 `FRAME` 块。
 *
 * 量出来的形状（`sph_intersect`，smallpt 自时间的大头，`objdump` 逐条看的）：
 *
 *     add  x22, sp, #0x570        ← FRAME 块：vdot 的两个按值实参拼在这儿
 *     ldr  x23, [x20, #0x18] / str x23, [x22]        ┐
 *     …（六对，把 *a 与 *b 整个拷进去）              │ 十二条
 *     ldr  x23, [x19, #0x10] / str x23, [x22, #0x28] ┘
 *     ldr  d8, [x20, #0x18]       ← 可真正算的时候读的是**源头**
 *     ldr  d9, [x19]                （`copyfwd.js` 那一格改过的）
 *     fsub d10, d8, d9
 *
 * 那十二条存进去之后**一次都没被读**。`elim unread autos`（`autos.js`）收不了它们 ——
 * 那一格只认「槽」（`STORE`/`LOAD` 的 aux），这儿是 `FRAME` 块加 `MSTORE`/`MLOAD`。
 *
 * 判据照抄 Go 的 `visit`
 * ---------------------
 *   - `addr[v] = 块号`：`v` 装着某个 FRAME 块的地址。种子是 `FRAME b` 自己，
 *     顺着 `ADD(地址, 常量)` 往下传（Go 那边是 `OffPtr`/`Addr` 的同一条）。
 *   - `MSTORE` 的**地址**那一格在 `addr` 里 ⇒ 这条写「跟着那个块一起死」（Go 的 `elim`）；
 *     它的**值**那一格在 `addr` 里 ⇒ 那是把一个块的地址写进内存，那个块**得留着**。
 *   - `MLOAD` 的地址在 `addr` 里 ⇒ 那个块被读过，**得留着**（Go 那边 Load 走的是
 *     `v.MemoryArg() != nil` 那一支，对每个带 auto 地址的实参 `usedAdd`）。
 *   - 地址值出现在**别的任何地方**（当实参传出去、存进槽、参与非常量算术、被 RET 带走……）
 *     ⇒ 那个块得留着。
 *
 * 迭代到不动点（Go 那边写死四轮就放弃；我们的 `ADD` 链是有界的，按指令条数封顶）。
 */

import { OP, OP_MODES, REF_BIAS, REF_NONE, memKindNo, memOff, MLOAD_BYTES, MSTORE_BYTES,
  memArgSize, OP_NAMES } from '../ir.js';
import { addrOf, constOffset } from './memory.js';
import { registerPass } from './pass.js';
import { removeInsns } from './edit.js';

/**
 * 就地删「写进从来没人读的 FRAME 块」的 MSTORE。回删了几条。
 */
export function deadAutoElim(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const n = fn.op.length;

  /* ---- 一、种子：每条 FRAME 自己装着它那一块的地址 */
  const addr = new Map();                 // ref -> 块号
  let any = false;
  for (let pc = 0; pc < n; pc++) {
    if (fn.op[pc] === OP.FRAME) { addr.set(REF_BIAS + pc, fn.aux[pc]); any = true; }
  }
  if (!any) return 0;

  /* ---- 二、顺着 `ADD(地址, 常量)` 与**槽**（`STORE 地址->槽s` / `LOAD 槽s`）传到不动点。
     槽这一条是精确的：槽取不到地址，所以"地址进了槽又读出来"还是同一个块的地址
     （与 `copyfwd.js` 的 `localFrame` 同一条判据）。
     不追槽这一步的代价是量出来的：`inline` 把内层 sret 指针存进槽、出了区域再读回来，
     于是整块判"地址跑出去了"，入口那份按值拷贝一条都收不掉。 */
  const loadsOf = new Map();            // 槽号 -> [LOAD 的 pc]
  for (let pc = 0; pc < n; pc++) {
    if (fn.op[pc] !== OP.LOAD) continue;
    let l = loadsOf.get(fn.aux[pc]);
    if (l === undefined) { l = []; loadsOf.set(fn.aux[pc], l); }
    l.push(pc);
  }
  const viaSlot = new Set();            // 哪些 STORE 是"把块地址存进槽"（第三步不算它逃逸）
  /**
   * 经过槽兜一圈的那些 ref，**偏移得跟着走**。
   *
   * `addrOf` 只会把 `ADD(base, 常量)` 拆回 `{base, off}` —— 地址进了槽再读出来，
   * 它看见的 base 就是那条 `LOAD` 本身、off 归零。于是
   * `STORE (B+0x48) -> 槽; LOAD 槽; MSTORE @0` 会被算成"写 B+0"，**记到错的格子上**。
   * 量到过：smallpt 的校验和从 243367 变成 0（活着的存储被删了）。
   *
   * 所以这儿另记一张 `ref -> 它离块头多远`。
   */
  const slotOff = new Map();
  /** 同一个 ref 被两个块（或同一块的两个偏移）喂到 ⇒ **都留着**。照 Go 的
   *  `elimDeadAutosGeneric`：`if addr[v] != node { usedAdd(node) }`（它那句注释写的是
   *  "This doesn't happen in practice, but catch it just in case"）。 */
  const conflict = new Set();
  const feed = (ref, block, off) => {
    const had = addr.get(ref);
    if (had === undefined) { addr.set(ref, block); slotOff.set(ref, off); return true; }
    if (had !== block || slotOff.get(ref) !== off) { conflict.add(had); conflict.add(block); }
    return false;
  };
  for (let round = 0; round < n + 1; round++) {
    let moved = false;
    for (let pc = 0; pc < n; pc++) {
      const op = fn.op[pc];
      /* `ADD(块地址, 常量)` 也是块地址（Go 的 `OffPtr`）。**这一条从前漏了**：文件头写着
       * "顺着 `ADD(地址, 常量)` 往下传"，而第二步只追了槽 —— 于是 `addr` 里永远只有
       * `FRAME` 本身，下面第三步那句 `if (op === OP.ADD && addr.has(…)) continue` 一次都
       * 不成立，每条取字段用的 `ADD` 都被当成"地址跑出去了"，**整块留着**。
       * 量出来的样子：`boxHit(a Box, r Ray)` 里 18 条候选、删 0 条，报的是
       * `%33 ADD 的 a（常量偏移 128）` —— 而那正是一条正经的取字段。 */
      if (op === OP.ADD) {
        const a0 = addrOf(fn, mod, REF_BIAS + pc);
        if (a0.base !== REF_BIAS + pc && addr.has(a0.base)) {
          const off = (slotOff.get(a0.base) || 0) + a0.off;
          if (feed(REF_BIAS + pc, addr.get(a0.base), off)) moved = true;
        }
        continue;
      }
      if (op !== OP.STORE) continue;
      const a = addrOf(fn, mod, fn.a[pc]);
      if (!addr.has(a.base)) continue;
      if (!viaSlot.has(pc)) { viaSlot.add(pc); moved = true; }
      const block = addr.get(a.base);
      const off = (slotOff.get(a.base) || 0) + a.off;
      for (const lp of (loadsOf.get(fn.aux[pc]) || [])) {
        if (feed(REF_BIAS + lp, block, off)) moved = true;
      }
    }
    if (!moved) break;
  }

  /* ---- 三、哪些块**得留着**（地址跑出去了），哪些格子被读过 */
  const kept = new Set();                 // 块号：地址跑出去了，一条都不敢删
  const readCells = new Map();            // 块号 -> [{lo, hi}]（被 MLOAD 读过的区间）
  const elim = new Map();                 // MSTORE 的 pc -> {block, lo, hi}
  /* `OMNI_DEADAUTO_STAT=1`：**为什么这一块一条都删不掉**。与 `OMNI_SROA_STAT` 同一个
     理由 —— 逃逸判据是唯一的闸，判紧一处整块的写就都留着，得能一眼看见是哪条指令判的。 */
  const stat = process.env.OMNI_DEADAUTO_STAT === '1';
  const keep = (ref, why) => {
    if (!addr.has(ref)) return;
    const b0 = addr.get(ref);
    if (stat && !kept.has(b0)) {
      process.stderr.write(`[deadauto] ${fn.name}: 块 ${b0} 逃逸（${why}）\n`);
    }
    kept.add(b0);
  };
  const cellAt = (pc, isLoad) => {
    const a = addrOf(fn, mod, fn.a[pc]);
    if (!addr.has(a.base)) return null;
    const k = memKindNo(fn.aux[pc]);
    /* `slotOff` 是这个 base 自己离块头多远（经过槽那一路才不是 0，见上面那段）。 */
    const lo = (slotOff.get(a.base) || 0) + a.off + memOff(fn.aux[pc]);
    const bytes = isLoad ? MLOAD_BYTES[k] : MSTORE_BYTES[k];
    return { block: addr.get(a.base), lo, hi: lo + bytes };
  };
  for (let pc = 0; pc < n; pc++) {
    const op = fn.op[pc];
    const m = OP_MODES[op];
    if (op === OP.MSTORE) {
      const c = cellAt(pc, false);
      if (c !== null) elim.set(pc, c);
      else keep(addrOf(fn, mod, fn.a[pc]).base, `%${pc} MSTORE 的偏移说不清`);
      /* 值那一格：把一个块的地址写进内存 ⇒ 那个块得留着 */
      keep(fn.b[pc], `%${pc} MSTORE 把块地址写进了内存`);
      continue;
    }
    if (op === OP.MLOAD) {
      const c = cellAt(pc, true);
      if (c === null) { keep(addrOf(fn, mod, fn.a[pc]).base, `%${pc} MLOAD 的偏移说不清`); continue; }
      let l = readCells.get(c.block);
      if (l === undefined) { l = []; readCells.set(c.block, l); }
      l.push(c);
      continue;
    }
    if (op === OP.ADD && addr.has(REF_BIAS + pc)) continue;   // 纯地址算术，已经传过了
    if (op === OP.STORE && viaSlot.has(pc)) continue;         // 地址进槽，第二步追过了
    /**
     * `RET` 带着一块的地址 = **返回一整块 struct**，不是"把地址交出去"：后端从那儿照
     * **返回类型的大小**读一次就完（arm64 上 ≤16 字节装进 x0/x1 或 d0-d3，见
     * `from_mir.js` 的 `OP.RET`；>16 字节那条路 RET 带的是调用方给的 x8 缓冲，
     * 那本来就不是我们的块）。两边都是**有界的一次读**，所以按格子记，
     * 别把整块判成逃逸。
     *
     * 为什么这一格值钱（量出来的）：C 前端给一个函数只划**一整块** `$frame`
     * （`tccgen.js` 的 `f.frame('$frame', this.frameSize, 16)`），返回值那个临时与按值
     * 形参的**防御性拷贝**住在同一块里。RET 一判"整块逃逸"，那些拷贝就一条都删不掉 ——
     *
     *     func boxHit(a Box, r Ray) (float64, float64)
     *
     * 里入口处 24 条 `MSTORE`（两个 48 字节的形参逐字段抄进帧块）**一次都没被读**
     * （真算的时候读的是源头，`copyfwd.js` 改过的），而 clang 在同一份 C 上把整个函数
     * 做到 **0 次访存**。同一族在 `pt` 那把尺子上是 `Box__Intersect` 44 条访存 vs
     * clang 的 0 条、`Tree__search` 301 vs 42。
     */
    /**
     * `ARGSRET %addr`（aux 与 `ARGMEM` 同一套，`memArgSize` 给字节数）= **被调方把它的
     * 返回值写进这一块**。那是 ABI 定死的一次**有界写**，既不读这一块别的地方、也不会
     * 把地址留下来（返回值那一块的寿命就是这次调用）。所以按格子记，别把整块判逃逸。
     *
     * 为什么要这一条：C 前端把返回值的临时也摆在那一整块 `$frame` 里 —— `boxHit` 里
     * `omni_new_S_m5()` 的 sret 缓冲就在块里偏移 112 处，于是"整块逃逸"把入口那 24 条
     * 按值形参的拷贝全留下了（候选 18 条、删 0 条）。
     *
     * 与 Go 的差别说在明处：Go 的 `elimDeadAutosGeneric` 对"地址进了调用"一律
     * `usedAdd(node)`（整个 auto 留着），因为它的 auto 早被 `decomposeUser` 拆成标量、
     * 一个 auto 就是一个格子，没有"同一块里还有别人"这件事。我们的块是一整帧，
     * 所以要按格子分开 —— 判据本身没放松：那次写能碰到的字节，ABI 说得死死的。
     */
    if (op === OP.ARGSRET) {
      const sa = addrOf(fn, mod, fn.a[pc]);
      const sb = memArgSize(fn.aux[pc]);
      if (addr.has(sa.base) && sb > 0) {
        const block = addr.get(sa.base);
        const lo = (slotOff.get(sa.base) || 0) + sa.off;
        let l = readCells.get(block);
        if (l === undefined) { l = []; readCells.set(block, l); }
        l.push({ block, lo, hi: lo + sb });
        continue;
      }
    }
    if (op === OP.RET && fn.a[pc] !== REF_NONE) {
      const ra = addrOf(fn, mod, fn.a[pc]);
      const rb = memArgSize(fn.retStruct);
      if (addr.has(ra.base) && rb > 0) {
        const block = addr.get(ra.base);
        const lo = (slotOff.get(ra.base) || 0) + ra.off;
        let l = readCells.get(block);
        if (l === undefined) { l = []; readCells.set(block, l); }
        l.push({ block, lo, hi: lo + rb });
        continue;
      }
    }
    /* 别的任何用法：地址跑出去了 ⇒ 留着。按角色问，'n'/'s'/'j' 那几格不是 ref。 */
    if (m[0] === 'r') {
      keep(fn.a[pc], `%${pc} ${OP_NAMES[op]} 的 a`
        + (op === OP.ADD ? `（b=${fn.b[pc]}，常量偏移 ${constOffset(fn, mod, fn.b[pc])}）` : ''));
    }
    if (m[1] === 'r') keep(fn.b[pc], `%${pc} ${OP_NAMES[op]} 的 b`);
    if (m[1] === 'p') {
      const at = fn.b[pc];
      const cnt = fn.args[at];
      for (let i = 0; i < cnt; i++) keep(fn.args[at + 1 + i], `%${pc} ${OP_NAMES[op]} 的第 ${i} 个实参`);
    }
  }

  /**
   * ---- 四、删「写进一个**没人读的格子**」的 MSTORE
   *
   * Go 的 `elimDeadAutosGeneric` 是**整个 auto** 的粒度（它的 auto 早就被
   * `decomposeUser` 拆成标量了，整块的粒度就够）。我们的 `FRAME` 块还是一整块，
   * 所以这儿按**格子**算 —— 同一条判据的自然对应：块不逃逸 ⇒ 读它的只有看得见的
   * 那几条 `MLOAD` ⇒ 写进一个与所有读区间都不相交的格子，观察不到。
   *
   * 量出来的就是这一族：`sph_intersect` 里按值实参的临时块，偏移 0..47 存进去九次、
   * 一次没读（真正算的时候读的是源头，`copyfwd.js` 改过的），偏移 48..71 才是
   * 返回值那一段、被读。整块粒度会因为那三格把十二条全留下。
   */
  const doomed = new Set();
  for (const [pc, c] of elim) {
    if (kept.has(c.block) || conflict.has(c.block)) continue;
    const reads = readCells.get(c.block);
    let hit = false;
    if (reads !== undefined) {
      for (const r of reads) {
        if (c.lo < r.hi && r.lo < c.hi) { hit = true; break; }
      }
    }
    if (!hit) doomed.add(pc);
  }
  if (stat) {
    for (const [b0] of readCells) {
      if (!kept.has(b0)) process.stderr.write(`[deadauto] ${fn.name}: 块 ${b0} 被读过的格子`
        + ` ${readCells.get(b0).map((r) => `${r.lo}|${r.hi}`).join(' ')}\n`);
    }
    process.stderr.write(`[deadauto] ${fn.name}: 候选 ${elim.size} 条、删 ${doomed.size} 条\n`);
  }
  if (doomed.size === 0) return 0;
  /* MSTORE 不产值（t = void），删它不会留下悬空 ref。喂它的那些纯计算没人引用之后
     由紧跟的 `generic deadcode` 收走。 */
  return removeInsns(fn, doomed);
}

registerPass('dead auto elim', deadAutoElim);
