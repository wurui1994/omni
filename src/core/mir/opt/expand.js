/**
 * expand calls（第 1 + 4 件的**内存形态**那一半）—— 照 Go 的 `ssacompile/expand_calls.go`。
 *
 * Go 在那个文件开头列了四件事，这一格做的是第 1 件与第 4 件：
 *   1. 每个**聚合实参**变成"拆开聚合、把零件传过去"
 *   4. 进来的**聚合实参**变成"把零件装配起来"
 *
 * **与 Go 的形状差别（照抄的是判据，不是形状）**：Go 的"零件"是寄存器里的 SSA 值，
 * 因为它的 ABI 是内部的、爱怎么传怎么传。我们要守 AAPCS（>16 字节的非 HFA 聚合传指针），
 * 所以这一格做的是同一件事的**内存形态**：把那次**防御性拷贝**消掉，让调用直接指向源头。
 * 效果是一样的 —— 那一块不再被取地址，`sroa.js` 与槽位提升随后就能把它拆成寄存器。
 *
 * 为什么这一刀值钱（量出来的，见 `sroa.js` 的 `OMNI_SROA_STAT` 与 `from_mir.js` 的
 * `OMNI_EMIT_STAT`）：smallpt 的 `radiance` 里 405 条访存**有 321 条落在同一个帧块上** ——
 * 就是那份按值收进来的 `Ray`。形状是这样的：
 *
 *     %2  LOAD   slot1:r          ← 调用方给的那一块的地址（形参）
 *     %3  MLOAD  %2 f64           ┐
 *     %4  MSTORE %0 %3 f64        │ 六对，把 *%2 逐字段抄进自己的帧块 %0
 *     …                           ┘   （前端的 `structCopy`：形参是实参的一份可改的拷贝）
 *     %16 ARGMEM %0 48            ← 把**自己那份拷贝**再传给下一个调用
 *
 * `%0` 的地址进了实参池 ⇒ `sroa.js` 判整块逃逸 ⇒ radiance 里每次读 `r.o`/`r.d` 都留在内存里。
 * 把 `%16` 的地址换成 `%2` 之后，`%0` 只剩"被写、没人读"，`dse`/`deadcode` 收走它，
 * 而 radiance 对 `r` 的访问改指向 `%2`（调用方那一块）—— 一次拷贝、一个帧块都不剩。
 *
 * **什么时候换得**（四条都要，缺一条就不换）
 * ------------------------------------------
 * 1. 那次拷贝是**逐格照抄**：`%0` 的每个格子都由一条 `MSTORE %0+off ← MLOAD %2+off` 写成，
 *    偏移与宽度符号都对上，而且**盖满** `ARGMEM` 说的那么多字节。少盖一格就说不清。
 * 2. 拷贝与那条 `ARGMEM` 之间**没有任何可能写内存的指令**（调用、别的 MSTORE…）——
 *    有的话 `*%2` 或 `%0` 可能已经不同了。判得保守：`mayWriteMemory` 名单之外一律算写。
 * 3. `%0` 在这条 `ARGMEM` 之前**只被那次拷贝写过**（别的写会让两块内容不同）。
 * 4. **被调函数不会写它收到的那一块**。这是唯一一条要跨函数看的：C 的按值形参是可改的
 *    拷贝，被调若真改了它，换成 `%2` 就把调用方自己的 `r` 改坏了。我们拿得到整个模块，
 *    所以这一条是**查出来的**，不是假设的 —— 查不到（`extern`/`decl`/按指针调用）就不换。
 *
 * 第 2/3 件（聚合返回值、多值出口）要先给 MIR 加多值返回（Go 的 `OpSelectN`），
 * 顺序与 Go 的注释同序，那是另一格。
 *
 * ⚠️ **现在这一版在 smallpt 上一次都不触发，差的是 `paramWritten` 要做成跨函数不动点。**
 *
 * 量出来的卡点（`OMNI_EXPAND_STAT=1` + `OMNI_SROA_STAT=1`）：radiance 那份 `Ray` 拷贝
 * 被传给**两个**调用（`intersect` 与递归的 `radiance`）。判据 2 要求"收到这一块的被调都
 * 不写它"，而 `paramWritten` 现在是**一层**的：它看见 `ARGMEM 那个形参的地址` 就答
 * "会写"（保守），于是 `paramWritten(radiance, 0)` = true —— radiance 把自己的形参地址
 * 往下传了，哪怕下面那个也只读。
 *
 * 要做对得把它改成**不动点**（标准的跨函数 mod 分析）：
 *   - 初值：所有 `(函数, 形参)` 假设"不写"；
 *   - 一遍遍扫：只要发现一条真写（`MSTORE` 走这个地址）或者传给了一个"会写"的位置，
 *     就把它翻成"会写"，直到不再变化；
 *   - 递归（radiance 调自己）靠这个初值自然收敛，不必特判。
 * 这一步没做之前，这一格是**只发诊断、不改图**的（已 cmp 验证产物逐字节不变）。
 */

import { OP, REF_BIAS, REF_NONE, memArgSize, memKindNo, memOff, MSTORE_BYTES, MSTORE_KINDS, MLOAD_KINDS } from '../ir.js';
import { addrOf, mayWriteMemory } from './memory.js';
import { registerPass } from './pass.js';

/** 这个 ref 是不是「取某个函数的地址」—— 取过地址的函数可能被经指针调用，签名与行为都不能假设。 */
function addrTakenFuncs(mod) {
  const taken = new Set();
  for (const fn of mod.funcs) {
    if (fn.op === undefined) continue;
    for (let pc = 0; pc < fn.op.length; pc++) {
      if (fn.op[pc] === OP.FADDR) taken.add(fn.aux[pc]);
    }
  }
  return taken;
}

/**
 * **被调函数会写它的第 p 个形参指着的那一块吗**（判据 4）。
 *
 * 形参在 MIR 里是"槽里装着那一块的地址"，所以问的是：有没有一条 `MSTORE` 的地址是
 * 从 `LOAD 那个形参槽` 派生出来的。派生只认 `ADD(地址, 常量)`（`addrOf` 就是干这个的）。
 *
 * 保守的三处：地址被存进别处、被当实参传给别的调用、或者派生链上有变量偏移 —— 一律算"会写"。
 */
function paramWritten(g, mod, p) {
  if (g === undefined || g.extern === true || g.decl === true) return true;
  if (g.params === undefined || p >= g.params.length) return true;
  const slot = g.params[p].slot;
  /* 那个形参槽被 LOAD 出来的那些 ref（就是"这一块的地址"） */
  const addrs = new Set();
  for (let pc = 0; pc < g.op.length; pc++) {
    if (g.op[pc] === OP.LOAD && g.aux[pc] === slot) addrs.add(REF_BIAS + pc);
  }
  if (addrs.size === 0) return false;             // 压根没读过这个形参 ⇒ 不会写
  for (let pc = 0; pc < g.op.length; pc++) {
    const o = g.op[pc];
    if (o === OP.MSTORE) {
      const a = addrOf(g, mod, g.a[pc]);
      if (addrs.has(a.base)) return true;
      continue;
    }
    /* 地址流去了别处（存进内存、进实参池、当返回值…）⇒ 说不清，算"会写" */
    if (o === OP.MLOAD) continue;                 // 读不算
    if (o === OP.ADD) continue;                   // 算地址，`addrOf` 会跟
    if (o === OP.LOAD || o === OP.STORE) continue; // 槽位另一套空间
    for (const r of [g.a[pc], g.b[pc]]) if (addrs.has(r)) return true;
    if (o === OP.CALL || o === OP.CCALL || o === OP.CALLI) {
      const at = g.b[pc];
      const n = g.args[at];
      for (let k = 0; k < n; k++) if (addrs.has(g.args[at + 1 + k])) return true;
    }
  }
  return false;
}

/** `MSTORE` 的宽度符号与 `MLOAD` 的是"同一个格子的全宽读写"吗（与 `sroa.js` 的 `kindPairOk` 同四对）。 */
function pairOk(loadKind, storeKind) {
  const ln = MLOAD_KINDS[loadKind], sn = MSTORE_KINDS[storeKind];
  return (ln === 'i64' && sn === 'i64') || (ln === 'i32s' && sn === 'i32')
      || (ln === 'f32' && sn === 'f32') || (ln === 'f64' && sn === 'f64');
}

/**
 * 跑这一格。回换了几处 `ARGMEM`。
 */
export function expandCalls(fn, mod) {
  if (!fn || fn.op.length === 0 || mod === undefined) return 0;
  const taken = addrTakenFuncs(mod);
  /* 一、这个函数里每条 `ARGMEM` 被哪个调用的第几格用着 */
  const useOf = new Map();          // ARGMEM 的 pc -> {callPc, pos}
  for (let pc = 0; pc < fn.op.length; pc++) {
    const o = fn.op[pc];
    if (o !== OP.CALL) continue;    // 只认直接调用：别的看不到被调是谁
    const at = fn.b[pc];
    const n = fn.args[at];
    for (let k = 0; k < n; k++) {
      const r = fn.args[at + 1 + k];
      if (r === REF_NONE || r < REF_BIAS) continue;
      if (fn.op[r - REF_BIAS] !== OP.ARGMEM) continue;
      useOf.set(r - REF_BIAS, { callPc: pc, pos: k });
    }
  }
  if (useOf.size === 0) return 0;

  let changed = 0;
  for (const [amPc, u] of useOf) {
    const blk = fn.a[amPc];                       // 那一块的地址（`FRAME` 或派生）
    const size = memArgSize(fn.aux[amPc]);
    if (!(size > 0) || size % 8 !== 0) continue;
    /* 判据 4 先查（最便宜的否定）：被调会写这一块就别动。
       `pos` 要减掉前面那一格 `ARGSRET`（返回值那一块不占形参的位置）。 */
    const g = mod.funcs[fn.a[u.callPc]];
    let pos = u.pos;
    {
      const at = fn.b[u.callPc];
      const r0 = fn.args[at + 1];
      if (r0 !== REF_NONE && r0 >= REF_BIAS && fn.op[r0 - REF_BIAS] === OP.ARGSRET
          && g !== undefined && (g.params === undefined || g.params.length === 0
            || g.params[0] === undefined || g.params[0].sret !== true)) {
        pos -= 1;
      }
    }
    if (pos < 0) continue;
    if (g === undefined || taken.has(fn.a[u.callPc])) continue;
    if (paramWritten(g, mod, pos)) continue;

    /* 判据 1：`blk` 的每个格子都由「照抄 src 同一偏移」写成，而且盖满 size 个字节。 */
    const cover = new Uint8Array(size);
    let src = REF_NONE;
    let lastStore = -1;
    let bad = false;
    for (let pc = 0; pc < amPc && !bad; pc++) {
      if (fn.op[pc] !== OP.MSTORE) continue;
      const a = addrOf(fn, mod, fn.a[pc]);
      if (a.base !== blk) continue;               // 写的是别的块
      const sk = memKindNo(fn.aux[pc]);
      const off = a.off + memOff(fn.aux[pc]);
      const w = MSTORE_BYTES[sk];
      if (!(off >= 0 && off + w <= size)) { bad = true; break; }
      /* 值必须是「从 src 的同一偏移读来的」 */
      const v = fn.b[pc];
      if (v === REF_NONE || v < REF_BIAS) { bad = true; break; }
      const vp = v - REF_BIAS;
      if (fn.op[vp] !== OP.MLOAD) { bad = true; break; }
      const la = addrOf(fn, mod, fn.a[vp]);
      const lk = memKindNo(fn.aux[vp]);
      if (la.off + memOff(fn.aux[vp]) !== off) { bad = true; break; }
      if (!pairOk(lk, sk)) { bad = true; break; }
      if (src === REF_NONE) src = la.base;
      else if (src !== la.base) { bad = true; break; }
      for (let q = 0; q < w; q++) cover[off + q] = 1;
      if (pc > lastStore) lastStore = pc;
    }
    if (bad || src === REF_NONE || lastStore < 0) continue;
    let full = true;
    for (let q = 0; q < size; q++) if (cover[q] === 0) { full = false; break; }
    if (!full) continue;
    /* 判据 2：拷贝做完之后，`blk` 与 `src` 指着的那两块**都不许再被写**。
     *
     * 判的不是"中间有没有写内存的指令"（那条太紧：这条 `ARGMEM` 可能在一千条之后、
     * 中间隔着好几个调用，而那些调用碰不到这两块）。判的是**可达性**：
     *   - 本函数里没有一条 `MSTORE` 的地址是从 `blk` 或 `src` 派生的；
     *   - 没有任何调用收到 `blk` 或 `src`（收到了就说不清它会不会写，除了我们正在改的
     *     这一条 —— 它的被调已经由判据 4 查过了）。
     * 帧块与"调用方那一块"都只能通过地址被碰到，地址没交出去 = 别人到不了。
     *
     * 扫**整个函数**而不是 `[lastStore, amPc)`：那条 `ARGMEM` 可能在循环里，
     * 而回边会把"文本上在它之后"的写带到下一轮它的前面。 */
    for (let pc = lastStore + 1; pc < fn.op.length && !bad; pc++) {
      const o = fn.op[pc];
      if (o === OP.MSTORE) {
        const a = addrOf(fn, mod, fn.a[pc]);
        if (a.base === blk || a.base === src) bad = true;
        continue;
      }
      if (o === OP.CALL || o === OP.CCALL || o === OP.CALLI) {
        const at = fn.b[pc];
        const n = fn.args[at];
        /* 被调收到 `blk`/`src` 不一定就坏 —— **它不写那一格就没事**，这与判据 4 是同一条。
         * 关键的一例：`blk` 常常被传给好几个调用（radiance 把那份 `Ray` 既给 `intersect`
         * 又给递归的自己），只要它们都只读，这次改写就仍然成立。
         * 查不到被调是谁（`CCALL`/`CALLI`）就算它会写。 */
        const cg = o === OP.CALL ? mod.funcs[fn.a[pc]] : undefined;
        let cpos = 0;
        for (let k = 0; k < n && !bad; k++) {
          const r = fn.args[at + 1 + k];
          if (r === REF_NONE || r < REF_BIAS) { cpos++; continue; }
          const rp = r - REF_BIAS;
          if (fn.op[rp] === OP.ARGSRET) continue;     // 返回值那一块不占形参的位置
          const inner = fn.op[rp] === OP.ARGMEM ? fn.a[rp] : r;
          if (inner === blk || inner === src) {
            if (cg === undefined || taken.has(fn.a[pc]) || paramWritten(cg, mod, cpos)) bad = true;
          }
          cpos++;
        }
        continue;
      }
      /* 地址被存进槽位/全局 ⇒ 可能从别处拿到，说不清 */
      if ((o === OP.STORE || o === OP.GSTORE) && (fn.a[pc] === blk || fn.a[pc] === src)) bad = true;
    }
    if (bad) continue;
    /* 判据 3：`blk` 在 `amPc` 之前只被那次拷贝写过 —— 上面那一遍已经把所有写 `blk` 的
       `MSTORE` 都验过了（不合形状就 `bad`），所以这儿不必再查一遍。 */

    fn.a[amPc] = src;
    changed++;
    if (process.env.OMNI_EXPAND_STAT === '1') {
      process.stderr.write(`[expand] ${fn.name}: %${amPc} 的那一块换成源头 %${src - REF_BIAS}`
        + `（${size} 字节，被调 ${g.name} 不写第 ${pos} 个形参）\n`);
    }
  }
  return changed;
}

registerPass('expand calls', expandCalls);
