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
 * ⚠️ **查清了：这一格在 smallpt 上不该触发 —— 我的前提（那次拷贝是多余的）本身是错的。**
 *
 * 判据都齐了（跨函数 mod 分析不动点 `paramModSet` 也做好了），每个候选现在都印为什么不换。
 * 印出来的答案是：
 *
 *     [expand] radiance: %16 不换（%131 MSTORE 又写了它）
 *
 * 也就是说 `radiance` 那个帧块在拷贝之后**又被写了**。查 C 源码：radiance 从不写 `r.o`/
 * `r.d`（它写的是另一个局部 `nr.o`/`nr.d`）—— 可这两个局部**在同一个帧块里**。
 * 量出来：radiance 有 87 个帧块，而**第 0 号就有 1568 字节**，聚合局部量是挤在一起的。
 *
 * 于是链条是这样的（与我先前记的"321 条全是那份 Ray 拷贝"**不同**，那句要作废）：
 *   - `sroa.js` 按**帧块身份**分组（`aliasId` 回 `F<块号>`）；
 *   - 那一块里只要有**一个**用法逃逸（这儿是 `ARGMEM` 把它传给 `intersect`），
 *     整块的所有局部量一起被放弃 —— 包括与那次调用毫无关系的 `nr`/`x`/`n`/`f`；
 *   - 所以 radiance 的 321 条访存不是"一份 Ray 拷贝"，是**一整块里所有聚合局部量**。
 *
 * 所以下一刀不在这一格，而在**粒度**上，两条路（都与 Go 对得上）：
 *   - `sroa.js` 改成**按格子**判逃逸而不是按整块：一个 `ARGMEM` 只能说明"它盖住的那几个
 *     格子"逃逸了，块里别的格子照样可以拆。Go 的 auto 本来就是一个变量一个，
 *     这一条等于把我们的粒度补到与它一样；
 *   - 或者前端给每个聚合局部量单独开一个帧块（`frameAlloc` 那一层），从源头上分开。
 * 前者不动前端、判据也更一般（对别的语言同样成立），应该先做前者。
 *
 * 在查清之前这一格**只发诊断、不改图**（已 cmp 验证产物逐字节不变）。
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
 * **跨函数的 mod 分析（不动点）**：`(函数, 形参) -> 它指着的那一块会被写吗`。
 *
 * 为什么必须是不动点而不是一层：C 的按值形参是"可改的拷贝"，而一个函数常常把自己
 * 形参的地址**再往下传**（radiance 把那份 `Ray` 既给 `intersect` 又给递归的自己）。
 * 一层的判据只能保守地答"会写"，于是这一格一次都不触发（量过）。
 *
 * 标准做法，三步：
 *   - **初值全假设"不写"**。这一条让递归自然收敛：radiance 调自己时读到的是"不写"，
 *     只有真找到一条写才会翻过来，翻了再传播一轮。
 *   - 每一轮对每个 `(g, p)` 重算一次：真写（`MSTORE` 走这个地址）、地址存进槽位/全局、
 *     或者传给一个"会写"的位置 —— 三者之一成立就是"会写"。
 *   - 翻过来的只会从"不写"变"会写"（单调），所以轮数有界、一定停。
 *
 * 保守的几处（一律算"会写"）：`extern`/`decl` 的被调、`CCALL`/`CALLI`（看不到是谁）、
 * 取过地址的函数（可能被经指针调用）、派生链上有变量偏移（`addrOf` 跟不动）。
 */
function paramModSet(mod, taken) {
  const write = new Set();                      // `${fi}:${p}` 在里头 = 会写
  const key = (fi, p) => `${fi}:${p}`;
  /* 形参位置 -> 被调的形参下标：调用点第一格可能是 `ARGSRET`（返回值那一块不占位置）。 */
  const calleeParamPos = (fn, callPc, k) => {
    const at = fn.b[callPc];
    let pos = k;
    const r0 = fn.args[at + 1];
    if (r0 !== REF_NONE && r0 >= REF_BIAS && fn.op[r0 - REF_BIAS] === OP.ARGSRET) pos -= 1;
    return pos;
  };
  for (let round = 0; round < mod.funcs.length + 2; round++) {
    let changed = false;
    for (let fi = 0; fi < mod.funcs.length; fi++) {
      const g = mod.funcs[fi];
      if (g === undefined || g.op === undefined || g.op.length === 0) continue;
      if (g.params === undefined) continue;
      for (let p = 0; p < g.params.length; p++) {
        if (write.has(key(fi, p))) continue;    // 已经是"会写"了，单调不回头
        const slot = g.params[p].slot;
        const addrs = new Set();
        for (let pc = 0; pc < g.op.length; pc++) {
          if (g.op[pc] === OP.LOAD && g.aux[pc] === slot) addrs.add(REF_BIAS + pc);
        }
        if (addrs.size === 0) continue;         // 压根没读过 ⇒ 不会写
        let w = false;
        for (let pc = 0; pc < g.op.length && !w; pc++) {
          const o = g.op[pc];
          if (o === OP.MSTORE) {
            if (addrs.has(addrOf(g, mod, g.a[pc]).base)) w = true;
            continue;
          }
          if (o === OP.MLOAD || o === OP.ADD || o === OP.LOAD) continue;
          /* 地址被存进槽位或全局 ⇒ 别处能拿到它，说不清 */
          if ((o === OP.STORE || o === OP.GSTORE) && addrs.has(g.a[pc])) { w = true; continue; }
          if (o === OP.CALL || o === OP.CCALL || o === OP.CALLI) {
            const at = g.b[pc];
            const n = g.args[at];
            for (let k = 0; k < n && !w; k++) {
              const r = g.args[at + 1 + k];
              if (r === REF_NONE || r < REF_BIAS) continue;
              const rp = r - REF_BIAS;
              const inner = (g.op[rp] === OP.ARGMEM || g.op[rp] === OP.ARGSRET) ? g.a[rp] : r;
              if (!addrs.has(inner)) continue;
              if (o !== OP.CALL) { w = true; break; }          // 看不到被调是谁
              const hi = g.a[pc];
              if (taken.has(hi) || mod.funcs[hi] === undefined) { w = true; break; }
              const h = mod.funcs[hi];
              if (h.extern === true || h.decl === true) { w = true; break; }
              if (write.has(key(hi, calleeParamPos(g, pc, k)))) w = true;
            }
            continue;
          }
          /* 别的 op 碰到这个地址（当返回值、进别的什么池…）⇒ 说不清 */
          if (addrs.has(g.a[pc]) || addrs.has(g.b[pc])) w = true;
        }
        if (w) { write.add(key(fi, p)); changed = true; }
      }
    }
    if (!changed) break;
  }
  return write;
}

/** `paramModSet` 的结果按模块缓存 —— 这一格每个函数都会被调一次，而它是模块级的分析。
 *  缓存键带上"全模块指令总数"：任何一次改图都会让它变，于是不会读到过期的结果。 */
const MOD_CACHE = new WeakMap();
function paramWrittenSet(mod, taken) {
  let total = 0;
  for (const f of mod.funcs) total += (f.op === undefined ? 0 : f.op.length);
  const hit = MOD_CACHE.get(mod);
  if (hit !== undefined && hit.total === total) return hit.write;
  const write = paramModSet(mod, taken);
  MOD_CACHE.set(mod, { total, write });
  return write;
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
  const written = paramWrittenSet(mod, taken);
  const writes = (fi, p) => {
    const g = mod.funcs[fi];
    if (g === undefined || g.extern === true || g.decl === true) return true;
    if (g.params === undefined || p < 0 || p >= g.params.length) return true;
    return written.has(`${fi}:${p}`);
  };
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
  if (process.env.OMNI_EXPAND_STAT === '1') {
    let ncall = 0;
    const shapes = [];
    for (let pc = 0; pc < fn.op.length; pc++) {
      const o = fn.op[pc];
      if (o !== OP.CALL && o !== OP.CCALL && o !== OP.CALLI) continue;
      ncall++;
      if (o !== OP.CALL) { shapes.push(`%${pc}:${o === OP.CCALL ? 'CCALL' : 'CALLI'}`); continue; }
      const g2 = mod.funcs[fn.a[pc]];
      const at = fn.b[pc];
      const n = fn.args[at];
      const ps = [];
      for (let k = 0; k < n; k++) {
        const r = fn.args[at + 1 + k];
        if (r === REF_NONE || r < REF_BIAS) { ps.push('k'); continue; }
        const rp = r - REF_BIAS;
        ps.push(fn.op[rp] === OP.ARGMEM ? 'ARGMEM' : fn.op[rp] === OP.ARGSRET ? 'ARGSRET' : 'v');
      }
      shapes.push(`%${pc}:${g2 ? g2.name : '?'}(${ps.join(',')})`);
    }
    process.stderr.write(`[expand] ${fn.name}: ${fn.op.length} 条指令、${ncall} 个调用、`
      + `${useOf.size} 个 ARGMEM 候选 —— ${shapes.slice(0, 12).join(' ')}\n`);
  }
  if (useOf.size === 0) return 0;

  let changed = 0;
  const stat = process.env.OMNI_EXPAND_STAT === '1';
  const no = (amPc, why) => {
    if (stat) process.stderr.write(`[expand] ${fn.name}: %${amPc} 不换（${why}）\n`);
    return false;
  };
  for (const [amPc, u] of useOf) {
    if (stat) process.stderr.write(`[expand] ${fn.name}: 看候选 %${amPc}\n`);
    const blk = fn.a[amPc];                       // 那一块的地址（`FRAME` 或派生）
    const size = memArgSize(fn.aux[amPc]);
    if (!(size > 0) || size % 8 !== 0) { no(amPc, `字节数 ${size} 不是 8 的倍数`); continue; }
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
    if (pos < 0) { no(amPc, '形参位置算不出来'); continue; }
    if (g === undefined || taken.has(fn.a[u.callPc])) { no(amPc, '被调看不见或取过地址'); continue; }
    if (writes(fn.a[u.callPc], pos)) { no(amPc, `被调 ${g.name} 会写第 ${pos} 个形参`); continue; }

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
    if (bad || src === REF_NONE || lastStore < 0) { no(amPc, '不是逐格照抄'); continue; }
    let full = true;
    for (let q = 0; q < size; q++) if (cover[q] === 0) { full = false; break; }
    if (!full) { no(amPc, '拷贝没盖满'); continue; }
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
    let badWhy = '拷贝之后 blk 或 src 还被碰';
    for (let pc = lastStore + 1; pc < fn.op.length && !bad; pc++) {
      const o = fn.op[pc];
      if (o === OP.MSTORE) {
        const a = addrOf(fn, mod, fn.a[pc]);
        if (a.base === blk || a.base === src) { bad = true; badWhy = `%${pc} MSTORE 又写了它`; }
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
            if (o !== OP.CALL || cg === undefined || taken.has(fn.a[pc])
                || writes(fn.a[pc], cpos)) {
              bad = true;
              badWhy = `%${pc} 把它传给 ${cg ? cg.name : '?'} 的第 ${cpos} 格，而那一格会写`;
            }
          }
          cpos++;
        }
        continue;
      }
      /* 地址被存进槽位/全局 ⇒ 可能从别处拿到，说不清 */
      if ((o === OP.STORE || o === OP.GSTORE) && (fn.a[pc] === blk || fn.a[pc] === src)) {
        bad = true; badWhy = `%${pc} 把地址存进了槽位/全局`;
      }
    }
    if (bad) { no(amPc, badWhy); continue; }
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
