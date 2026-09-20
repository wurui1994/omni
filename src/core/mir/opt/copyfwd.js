/**
 * 「刚被拷过的那一块，读它可以直接读源头」—— `generic.rules:865`：
 *
 *     // Load from a region just copied by Move can read directly from the source.
 *     (Load <t1> op1:(OffPtr [o1] p1) move:(Move [n] p2 src mem))
 *       && o1 >= 0 && o1+t1.Size() <= n && ssa.IsSamePtr(p1, p2)
 *       && !ssa.IsVolatile(src)
 *       => @move.Block (Load <t1> (OffPtr <op1.Type> [o1] src) mem)
 *
 * 为什么这一格值钱（**量出来的，不是想出来的**）
 * ----------------------------------------------
 * `/usr/bin/sample` 打出来 smallpt 的自时间：`sph_intersect` 208 样本（47%）。
 * 它跑完整条管线之后的原生 MIR 里，**MLOAD 52 + MSTORE 36 = 88 条访存**，
 * 而真算术只有 SUB 10 + ADD 8 + MUL 7 = 25 条。那 88 条的形状是：
 *
 *     %24  FRAME  1                     ← 内联进来的 vsub 给两个按值实参开的块
 *     %27  MLOAD  i64  %26 i64          ← 从 *a 读一个字
 *     %28  MSTORE i64  %24 %27 i64      ← 拷进块里
 *     …（六对，把 *a 与 *b 整个拷进去）
 *     %40  MLOAD  f64  %24 f64          ← 再按 f64 读回来
 *     %41  MLOAD  f64  %24 f64@24
 *     %42  SUB    f64  %40 %41          ← 真正要算的就这一条
 *
 * 一条 `SUB` 前面垫着十八条访存。这一格把 `%40` 改成直接读 `%26`，
 * 那六对拷贝随后没人要，`dse` 与 deadcode 收走。
 *
 * 为什么 `decompose user`（SROA）收不了这一族：同一个格子**存的时候是 i64、
 * 读的时候是 f64**（C 前端的按值拷贝是按字拷的，不看字段类型），`sroa.js` 的
 * `scanBase` 在「同一格两种类型：不碰」那一行就退了。Go 那边压根没有这个形状 ——
 * 它的 struct 在 SSA 里是**值**，`decomposeUser` 在任何内存出现之前就拆完了。
 *
 * 两条安全判据（都要成立才改）
 * --------------------------
 * 1. **读的那一块是个不逃逸的 FRAME 块**（`localFrame`）：它的地址只当访存地址与
 *    `ADD(它, 常量)` 用过，从没存到别处去。于是「别人的指针指不进这一块」——
 *    这一条顶替了 Go 的 `IsSamePtr`/内存 SSA 链：基址不同的写一定碰不到它。
 * 2. **源头那一段在拷完到读到之间没被写过**：从源头那条 MLOAD 往后走到这条读，
 *    只许出现「写进那个不逃逸块的 MSTORE」与不写内存的指令。写进不逃逸块的 MSTORE
 *    碰不到源头 —— 源头的指针不可能指进那一块（第 1 条）。
 */

import {
  OP, OP_MODES, REF_BIAS, REF_NONE,
  memDesc, memKindNo, memOff,
  MLOAD_KINDS, MSTORE_KINDS, MLOAD_BYTES, MSTORE_BYTES,
  CVT_BITCAST,
} from '../ir.js';
import { addrOf, cellOf, sameSpot, disjoint, mayWriteMemory, constOffset } from './memory.js';
import { inScope, regionScope, loopInfo, extraSpans } from './region.js';
import { useSites } from './sroa.js';

/** 两个宽度符号**盖的字节数一样**，但一个是整数、一个是浮点（`MLOAD` 那边 / `MSTORE` 那边）。 */
function sameWidthDifferentKind(kl, ks) {
  if (MLOAD_BYTES[kl] !== MSTORE_BYTES[ks]) return false;
  const ln = MLOAD_KINDS[kl], sn = MSTORE_KINDS[ks];
  if (ln === undefined || sn === undefined) return false;
  const lf = ln === 'f32' || ln === 'f64' || ln === 'f80';
  const sf = sn === 'f32' || sn === 'f64' || sn === 'f80';
  return lf !== sf;
}

/** 哪些槽被**读过**（有 `LOAD`）。没人读的槽，往里写什么都观察不到。 */
function loadedSlots(fn) {
  const s = new Set();
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] === OP.LOAD) s.add(fn.aux[pc]);
  }
  return s;
}

/** 哪些槽被**读过**（有 `LOAD`），以及每个槽的 `LOAD` 都在哪几条。 */
function slotLoads(fn) {
  const at = new Map();             // 槽号 -> [LOAD 的 pc]
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] !== OP.LOAD) continue;
    let l = at.get(fn.aux[pc]);
    if (l === undefined) { l = []; at.set(fn.aux[pc], l); }
    l.push(pc);
  }
  return at;
}

/**
 * 这个 ref 是**不逃逸的 FRAME 块**的基址吗。
 *
 * 判据与 `sroa.js` 的 `scanBase` 同一条（只是这儿不要格子表，只要一个是/不是）：
 * 从它派生出来的每一个 ref，要么当 MLOAD/MSTORE 的地址用，要么是 `ADD(它, 常量)`。
 * 别的用法（存到内存里、当实参传出去、参与非常量算术）一律算逃逸。
 *
 * **地址经过槽兜一圈也照追**：`STORE 它 -> 槽s` 之后，`LOAD 槽s` 读回来的还是这个地址，
 * 所以把那几条 `LOAD` 的结果一起接着查。这一步是精确的、不是放宽 ——
 * 槽**取不到地址**（`OP_MODES` 里带 `'s'` 的只有 `LOAD`/`STORE`），
 * 所以"有没有指针从槽里漏出去"就等于"那几条 `LOAD` 的结果拿去干什么了"。
 * 没人 `LOAD` 的槽更简单：写进去的东西观察不到，那条 STORE 直接跳过。
 *
 * 为什么非追不可（量出来的）：`inline` 把内层 `V()` 的 sret 指针存进
 * `slot9:vsub$V$$sret`、出了区域再 `LOAD` 回来当 MSTORE 的地址用。那个槽的 STORE 在
 * 内层区域里、LOAD 在它的 `END` 之后 —— MIR 没有 phi，mem2reg 提升不掉（region.js 的规矩）。
 * 不追这一步，`sph_intersect` 里按值收的那份 `Ray` 拷贝整块判逃逸，
 * 入口那 12 条拷贝一条都收不掉。
 */
function localFrame(fn, mod, sites, ref, cache, loaded, loadsOf) {
  const hit = cache.get(ref);
  if (hit !== undefined) return hit;
  let ok = true;
  if (ref === REF_NONE || ref < REF_BIAS || fn.op[ref - REF_BIAS] !== OP.FRAME) {
    ok = false;
  } else {
    const seen = new Set();
    const work = [ref];
    while (ok && work.length > 0) {
      const cur = work.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const list = sites.get(cur);
      if (list === undefined) continue;
      for (const u of list) {
        const op = fn.op[u.pc];
        if ((op === OP.MLOAD || op === OP.MSTORE) && u.role === 'a') continue;
        if (op === OP.STORE && u.role === 'a') {
          const s = fn.aux[u.pc];
          if (!loaded.has(s)) continue;                 // 没人读那个槽 ⇒ 观察不到
          for (const lp of (loadsOf.get(s) || [])) work.push(REF_BIAS + lp);
          continue;                                     // 地址接着从那几条 LOAD 往下查
        }
        if (op === OP.ADD && (u.role === 'a' || u.role === 'b')) {
          const other = u.role === 'a' ? fn.b[u.pc] : fn.a[u.pc];
          if (constOffset(fn, mod, other) !== null) { work.push(REF_BIAS + u.pc); continue; }
        }
        ok = false;
        break;
      }
    }
  }
  cache.set(ref, ok);
  return ok;
}

/** 这条 MSTORE 写的是不逃逸块 `frame` 吗（那样它碰不到别人）。 */
function writesOnly(fn, mod, pc, frame) {
  if (fn.op[pc] !== OP.MSTORE) return false;
  return addrOf(fn, mod, fn.a[pc]).base === frame;
}

/**
 * 从 `pcLoad` 往回找「写同一处」的那条 MSTORE。回它的 pc，或 -1。
 *
 * **跨块**（整个函数往回走，不限在基本块里）。能跨靠的是 `region.js` 文件头那条：
 * 结构化控制流里「pcA 在 pcB 之前、且 pcA 那层区域在 pcB 处还开着」就是真的支配
 * —— 同一层区域里不存在往前跳过某条指令的跳转，`BR`/`BRIF` 只往区域的 END 或循环头跳，
 * 而跳过 pcStore 的那些跳转必然也跳过 pcLoad（两条在同一层或 pcLoad 在更内层）。
 *
 * 三种情形，一条一条判：
 *   - 同一处、而且那条存储在这儿**还在作用域里** ⇒ 找到了；
 *   - 同一处、但区域已经关掉（可能没执行过）⇒ 停，不敢用；
 *   - 一定不相交 ⇒ 接着往前找；基址不同而读的那块不逃逸 ⇒ 也接着往前找。
 *
 * 与 `rewrite.js` 的 `lookBackStore` 的差别：那一条要求读回来**就是**写进去的值
 * （`sameCell`，宽度与类型都一样），这一条只要求**同一段字节**。
 */
function lookBackCopy(fn, mod, sc, pcLoad, want) {
  for (let pc = pcLoad - 1; pc >= 0; pc--) {
    const op = fn.op[pc];
    if (op === OP.MSTORE) {
      const got = cellOf(fn, mod, pc, false);
      if (disjoint(got, want)) continue;
      /* 基址不同：读的那一块不逃逸 ⇒ 这条写碰不到它（见文件头第 1 条）。 */
      if (got.base !== want.base) continue;
      if (sameSpot(want, got)) return inScope(sc, pc, pcLoad) ? pc : -1;
      return -1;                       // 相交但不是同一处 ⇒ 证不了
    }
    if (mayWriteMemory(op)) return -1;
  }
  return -1;
}

/**
 * 源头那一段在**从 `pcSrc` 走到 `pcLoad` 的路上**没被写过吗（见文件头第 2 条）。
 *
 * 要扫的不只是 `[pcSrc+1, pcLoad-1]`：`pcLoad` 在一个开在 `pcSrc` 之后的 `LOOP` 里时，
 * 循环体里 `pcLoad` 往后那一段在下一轮之前也跑过（`region.js` 的 `extraSpans`）。
 */
function srcIntact(fn, mod, li, pcSrc, pcLoad, frame) {
  const spans = [[pcSrc + 1, pcLoad - 1]];
  for (const s of extraSpans(li, pcSrc, pcLoad)) spans.push(s);
  for (const [from, to] of spans) {
    for (let pc = from; pc <= to; pc++) {
      const op = fn.op[pc];
      if (!mayWriteMemory(op)) continue;
      if (writesOnly(fn, mod, pc, frame)) continue;
      return false;
    }
  }
  return true;
}

/**
 * 跑这一格。回改了几条 MLOAD。
 *
 * 只改被改的那条 MLOAD 自己的 `a` 与 `aux`（地址换成源头、静态偏移换成源头的），
 * **一条指令都不增不减** —— 拷贝那几对由紧跟的 `dse` 与 deadcode 收。
 */
export function forwardCopiedLoads(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const sites = useSites(fn);
  const cache = new Map();
  const loaded = loadedSlots(fn);
  const loadsOf = slotLoads(fn);
  const sc = regionScope(fn);
  const li = loopInfo(fn);
  let n = 0;
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] !== OP.MLOAD) continue;
    const want = cellOf(fn, mod, pc, true);
    /* 一、读的是个不逃逸的 FRAME 块 */
    if (!localFrame(fn, mod, sites, want.base, cache, loaded, loadsOf)) continue;
    /* 二、往回找写这一处的那条拷贝（跨块，靠区域作用域当支配判据） */
    const pcS = lookBackCopy(fn, mod, sc, pc, want);
    if (pcS < 0) continue;
    const kl = memKindNo(fn.aux[pc]);
    const ks = memKindNo(fn.aux[pcS]);
    if (MLOAD_BYTES[kl] !== MSTORE_BYTES[ks]) continue;
    /* 三、写进去的值本身是一条 MLOAD ⇒ 那才叫"拷过来的"，改成直接读源头（最省）。
       源头的**地址**得在这儿还看得见（`inScope`），不然换过去就是引用一个关掉的区域里的值。 */
    const v = fn.b[pcS];
    if (v !== REF_NONE && v >= REF_BIAS && fn.op[v - REF_BIAS] === OP.MLOAD) {
      const pcSrc = v - REF_BIAS;
      const addr = fn.a[pcSrc];
      const addrOk = addr < REF_BIAS || addr === REF_NONE || inScope(sc, addr - REF_BIAS, pc);
      const kr = memKindNo(fn.aux[pcSrc]);
      if (addrOk && MLOAD_BYTES[kl] === MLOAD_BYTES[kr]
          && srcIntact(fn, mod, li, pcSrc, pc, want.base)) {
        /* 改地址：换成源头的地址 + 源头的静态偏移，**宽度符号照我们自己的** */
        fn.a[pc] = addr;
        fn.aux[pc] = memDesc(kl, memOff(fn.aux[pcSrc]));
        n++;
        continue;
      }
    }
      /**
       * 四、**位宽一样、只是整数/浮点那一位不同** ⇒ 这条 MLOAD 就地变成
       * 「把写进去那个值按位重解释」（`CVT` 的 `CVT_BITCAST`）。
       *
       * 这是 `generic.rules:839` 那一族
       *     (Load <t1> p1 (Store {t2} p2 x _)) && IsSamePtr && copyCompatibleType(t1, x.Type)
       * 的**放宽一档**：Go 的 `copyCompatibleType`（`generic_helpers.go:95`）要求
       * 整数配整数、指针配指针、别的类型完全相等，所以它**不**转发 i64 存 / f64 读。
       * Go 不需要那一档，是因为它的 struct 在 SSA 里是**值**，`decomposeUser` 在任何
       * 内存出现之前就按字段类型拆完了；而我们的 C 前端按值拷贝是**按字**拷的
       * （`MSTORE i64`），字段类型的信息在那一步就丢了。
       *
       * 放宽这一档是**语义精确**的，不是猜：两边覆盖同一段字节、同样宽，
       * 位模式一模一样，`CVT_BITCAST` 正是"同一串位换个读法"。
       *
       * 量出来的形状（`sph_intersect` 里 `op = vsub(...)` 之后那一段）：
       *     str d10,[x22]              ← 结果本来就在寄存器里
       *     ldr x23,[x22] / str x23,[sp,#0x138]   ┐ 十五条访存
       *     ldr x22,[sp,#0x138] / str x22,[x19,#0x48] ┘ 只为把三个 double 搬到另一处
       *     ldr d8,[x19,#0x30]         ← 再读回来
       * 一档一档转发下去之后整条链都变成 `CVT_BITCAST`，而两个宽度相同的 BITCAST
       * 互相抵消（`rewrite.js` 里那一条恒等式），最后剩下的就是那个寄存器里的值。
       */
    if (!sameWidthDifferentKind(kl, ks)) continue;
    if (v === REF_NONE) continue;
    /* 那个值在这儿得看得见（跨块之后这一问不再是白送的）。 */
    if (v >= REF_BIAS && !inScope(sc, v - REF_BIAS, pc)) continue;
    fn.op[pc] = OP.CVT;
    fn.a[pc] = v;
    fn.b[pc] = REF_NONE;
    fn.aux[pc] = CVT_BITCAST;
    n++;
  }
  return n;
}

/* 这一格是 `generic.rules` 里的一条，所以不占通道表的格子 —— 由 `rewrite.js` 的
 * `opt` / `middle opt` / `late opt` 三遍各跑一次，与 `forwardLoads` 并列。 */
