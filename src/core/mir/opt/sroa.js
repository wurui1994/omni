/**
 * decompose user（SROA）—— 把**从不逃逸的内存块**按格子拆成槽位。
 *
 * 为什么这一格是那个杠杆（ADR-0039 第 8 节的第三条）
 * ------------------------------------------------
 * `radiance` 过完整条管线还有 562 条指令，其中 `MLOAD 89 + MSTORE 84 + LOAD 50 +
 * STORE 49 = 272`（**48%**）是访存，而 `ADD 79 / MUL 16 / DIV 5` 才是活。根因是
 * C 前端把按值传的 struct（那个 `Vec`）全摆在**帧上的一块**（`FRAME`）里：每次取字段、每次赋值都是
 * 一条 `MLOAD`/`MSTORE`，而它们的地址还各要一条 `ADD`。clang -O2 把它们全放进寄存器。
 *
 * 一条 `LOAD 槽` 在后端是**一条** `ldr [sp, #off]`；一条 `MLOAD ADD(base,k)` 是
 * 「算地址 + 读」两三条，而且那个地址值自己还占一个值栈位。所以把格子换成槽位，
 * 在访存这一轴上直接减一半的指令 —— 而且换完之后 mem2reg 与 regalloc 才有得可做。
 *
 * 与 Go 的对应关系（照抄的是**判据**，不是形状）
 * --------------------------------------------
 * Go 的 `decompose user`（`ssa/decompose.go`）拆的是**struct 的 SSA 值**
 * （阈值 `MaxStruct = 4`，见 `ssa/value.go:CanSSA`）—— 它的前端会先把小 struct 变成
 * SSA 值。我们的 C 前端从不产 struct SSA 值，它产的是「线性内存上的一块」，
 * 所以同一件事在这儿的形状是 LLVM 的 SROA：**块 -> 若干标量**。
 * 判据是同一个：**地址从不逃逸**（Go 的 escape 那一步、LLVM 的 `isAllocaPromotable`）。
 *
 * 怎么做（就地换 op，不增不减一条指令）
 * ----------------------------------
 *   `MLOAD addr`      -> `LOAD  slot`
 *   `MSTORE addr v`   -> `STORE v slot`
 * 地址那几条 `ADD` 随后没人引用，紧跟的 deadcode 收走。一条指令都不插、不删，
 * 所以这一格改不坏控制流（与 `opt` 那一格同一条纪律）。
 *
 * 判"不逃逸"的白名单
 * -----------------
 *   - 当 `MLOAD`/`MSTORE` 的**地址**用（`a` 那一格）
 *   - 当 `ADD(base, 整数常量)` 的操作数用（那还是个地址，接着往下查）
 *   - 当 `ARGMEM`/`ARGSRET` 的地址用：**逃逸的只是它盖住的那几个字节**（见下面那一段）
 * 别的（进实参池当裸指针、被存进内存、当返回值…）说不清盖住哪儿，一律放弃整个 base。
 *
 * 粒度是**格子**，不是整块（这一格是第二版的要点）
 * ---------------------------------------------
 * `aliasId` 把一个 `FRAME` 帧块当成一个分组 —— 可一个帧块里摆着**一堆互不相干的局部量**
 * （smallpt 的 `radiance` 只有 87 个帧块，而 0 号那块 1568 字节）。第一版里
 * 任何一处逃逸、任何一个格子上的类型/宽度冲突，都让**整块**放弃：`radiance` 里
 * 那条 `ARGMEM %0 48`（把自己那份 `Ray` 传给 `intersect`）于是把 `nr`/`x`/`n`/`f`
 * 这些与那次调用毫无关系的局部量一起摁死，321 条访存一条也收不掉。
 *
 * Go 的 auto 本来就**一个变量一格**（`decompose user` 拆的是单个 SSA 值），所以
 * "按格子判"才是与它对得上的粒度。这一版：
 *   - `ARGMEM`/`ARGSRET` 的字节数是写在 aux 里的（`memArgSize`），于是逃逸记成**一段区间**，
 *     只有**压在那段上**的格子不换，别的照换；
 *   - 格子上的类型冲突、两种读/写宽、只读没写过、读写宽度对不上、与别人部分重叠 ——
 *     统统只让**那一个格子**不换。
 * 只有"说不清盖住哪几个字节"的逃逸（裸指针进实参池、地址被存进内存…）才还是放弃整块 ——
 * 那种情况下块里哪个格子都可能被碰到。
 */

import {
  OP, OP_MODES, OP_NAMES, REF_BIAS, REF_NONE,
  MLOAD_BYTES, MSTORE_BYTES, MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff, memArgSize,
} from '../ir.js';
import { addrOf, constOffset } from './memory.js';
import { registerPass } from './pass.js';

/** 每个 ref 被哪些 (pc, 角色) 用着。角色：'a'/'b'/'p'（实参池里）。 */
export function useSites(fn) {
  const sites = new Map();      // ref -> [{pc, role}]
  const add = (ref, pc, role) => {
    if (ref === REF_NONE || ref < REF_BIAS) return;
    let l = sites.get(ref);
    if (l === undefined) { l = []; sites.set(ref, l); }
    l.push({ pc, role });
  };
  for (let pc = 0; pc < fn.op.length; pc++) {
    const m = OP_MODES[fn.op[pc]];
    if (m[0] === 'r') add(fn.a[pc], pc, 'a');
    if (m[1] === 'r') add(fn.b[pc], pc, 'b');
    if (m[1] === 'p') {
      const at = fn.b[pc];
      const n = fn.args[at];
      for (let i = 0; i < n; i++) add(fn.args[at + 1 + i], pc, 'p');
    }
  }
  return sites;
}

/**
 * 从 `ref`（它指向"本块偏移 `off` 处"）往下走，把**通过它访问到的字节区间**记进 `out`。
 * 回 `false` = 有一处说不清（那就只能当"整块逃逸"）。
 *
 * 与 `scanBase` 的第一、二条同一套判据，差别只在：这儿的偏移是**相对给定的 off**，
 * 而且不记格子（只记区间）—— 因为这些字节要留在内存上，拆不了。
 */
function relCells(fn, mod, ref, off, sites, out, seen) {
  if (seen.has(ref)) return true;
  seen.add(ref);
  const list = sites.get(ref);
  if (list === undefined) return true;             // 没人用
  for (const u of list) {
    const op = fn.op[u.pc];
    if ((op === OP.MLOAD || op === OP.MSTORE) && u.role === 'a') {
      const k = memKindNo(fn.aux[u.pc]);
      const lo = off + memOff(fn.aux[u.pc]);
      out.push({ lo, hi: lo + (op === OP.MLOAD ? MLOAD_BYTES[k] : MSTORE_BYTES[k]) });
      continue;
    }
    if (op === OP.ADD && (u.role === 'a' || u.role === 'b')) {
      const other = u.role === 'a' ? fn.b[u.pc] : fn.a[u.pc];
      const k = constOffset(fn, mod, other);
      if (k === null) return false;
      if (!relCells(fn, mod, REF_BIAS + u.pc, off + k, sites, out, seen)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * `STORE 本块里的一个地址 -> slot`，而那个槽**还有人读**。这一条从前是"放弃整块"，
 * 现在先试着**把它盖住的字节算出来**：算得出来就只让那几个格子不换。
 *
 * 为什么非要这一格（量出来的，radiance）：C 前端给三目运算的左值开一个**指针临时槽**
 * （`$selN`）—— `Vec nl = vdot(n, r.d) < 0 ? n : vmul(n, -1);` 两支各
 * `STORE ADD(%0,k) -> $sel20`，`END` 之后再 `LOAD $sel20` 去 MLOAD。那条 LOAD 跨了区域
 * 边界，而两支存的地址不同 —— MIR 没有 phi，mem2reg 转发不了（`region.js` 的词法作用域
 * 那条规矩），于是 0 号帧块里 393 条访存全留在内存上。
 *
 * 能算出来的条件（都要）：
 *   - 存进这个槽的**每一个**值都是"本块 + 常量偏移"（拿到的是那几个 `k_i`）；
 *   - `LOAD 这个槽`的结果**只**当访存地址用（顺着 `ADD(·, 常量)` 走，拿到 `(o_j, w_j)`）。
 * 那么被碰到的字节就是 `{[k_i+o_j, k_i+o_j+w_j)}` 这个叉乘 —— 别的格子照拆。
 *
 * 回 `null` = 算不出来（调用方放弃整块）。
 */
function slotEscapes(fn, mod, base, slot, sites) {
  const ks = [];
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] !== OP.STORE || fn.aux[pc] !== slot) continue;
    const v = fn.a[pc];
    if (v === REF_NONE || v < REF_BIAS) return null;      // 往里存的不是个地址
    const a = addrOf(fn, mod, v);
    if (a.base !== base) return null;                     // 存的是别处的地址：说不清
    ks.push(a.off);
  }
  if (ks.length === 0) return null;
  const rel = [];
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] !== OP.LOAD || fn.aux[pc] !== slot) continue;
    if (!relCells(fn, mod, REF_BIAS + pc, 0, sites, rel, new Set())) return null;
  }
  const out = [];
  /* 叉乘要封顶：`ks × rel` 还要再喂给后面 `cells × escapes` 那一趟，大帧块上很容易上十万级
     —— 裸指针实参那一版就是在这儿把判据跑卡死的。超了就当"算不出来"，放弃整块。 */
  if (ks.length * rel.length > 1024) return null;
  for (const k of ks) for (const r of rel) out.push({ lo: k + r.lo, hi: k + r.hi });
  return out;
}


/**
 * 查一个 base：它派生出来的地址都只当访存的地址用吗。
 *
 * 格子记进 `cells`（`Map(键 -> {lo, hi, t, loadKind, storeKind, pcs, bad})`，键是 `lo|hi`），
 * "盖住哪几个字节是知道的"那种逃逸记进 `escapes`（`{lo, hi}`）—— 两个都是**整堆共用**的，
 * 因为同一块内存在一个函数里会有好几个 base ref（见 `aliasId`）。
 *
 * 回 `true` = 这个 base 上没有"说不清范围"的逃逸。回 `false` = 放弃整堆。
 */
function scanBase(fn, mod, base, sites, unreadSlots, cells, escapes) {
  const seen = new Set();
  const work = [base];
  const stat = process.env.OMNI_SROA_STAT === '1';
  /* `OMNI_SROA_STAT=1`：**为什么放弃这一块**。逃逸判据是这一格唯一的闸，判紧一处
   * 整块访存就都收不掉，所以要能一眼看见原因（量过再改，别猜）。 */
  const no = (why) => {
    if (stat) process.stderr.write(`[sroa] ${fn.name}: 放弃 %${base - REF_BIAS}（${why}）\n`);
    return false;
  };
  const badCell = (c, why) => {
    if (stat && !c.bad) process.stderr.write(`[sroa] ${fn.name}: 格子 ${c.lo}|${c.hi} 不换（${why}）\n`);
    c.bad = true;
  };
  while (work.length > 0) {
    const ref = work.pop();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const list = sites.get(ref);
    if (list === undefined) continue;           // 没人用（比如被 deadcode 留下的）
    for (const u of list) {
      const op = fn.op[u.pc];
      /* 一、当访存的地址用 —— 记下这个格子 */
      if ((op === OP.MLOAD || op === OP.MSTORE) && u.role === 'a') {
        const isLoad = op === OP.MLOAD;
        const a = addrOf(fn, mod, fn.a[u.pc]);
        if (a.base !== base) return no(`%${u.pc} 的派生链上有非常量偏移`);
        const k = memKindNo(fn.aux[u.pc]);
        const lo = a.off + memOff(fn.aux[u.pc]);
        const hi = lo + (isLoad ? MLOAD_BYTES[k] : MSTORE_BYTES[k]);
        const key = `${lo}|${hi}`;
        let c = cells.get(key);
        if (c === undefined) {
          c = { lo, hi, t: fn.t[u.pc], loadKind: -1, storeKind: -1, pcs: [], bad: false };
          cells.set(key, c);
        }
        /* 这三道从前是"放弃整块"，现在只判**这一个格子** —— 一块里摆着一堆
           互不相干的局部量，一个格子上的冲突说明不了别的格子的事。 */
        if (c.t !== fn.t[u.pc]) badCell(c, '同一格上两种类型');
        if (isLoad) { if (c.loadKind >= 0 && c.loadKind !== k) badCell(c, '两种读宽'); c.loadKind = k; }
        else { if (c.storeKind >= 0 && c.storeKind !== k) badCell(c, '两种写宽'); c.storeKind = k; }
        c.pcs.push(u.pc);
        continue;
      }
      /* 二、`ADD(地址, 整数常量)` —— 还是个地址，接着往下查 */
      if (op === OP.ADD && (u.role === 'a' || u.role === 'b')) {
        const other = u.role === 'a' ? fn.b[u.pc] : fn.a[u.pc];
        /* 另一边得是个**编译期常数**（可以是一棵小树：`MUL(k0,k4)` 那种，见
           `memory.js` 的 `constOffset`）。是变量下标就说不清碰了哪个格子。 */
        if (constOffset(fn, mod, other) !== null) { work.push(REF_BIAS + u.pc); continue; }
        return no(`%${u.pc} 加的是个变量`);
      }
      /* 三、`ARGMEM`/`ARGSRET` 的地址 —— **逃逸的只是它盖住的那几个字节**。
         字节数就写在 aux 里（`memArgSize`，见 ir.js 的 MEMARG 那一段），所以这一种
         不必放弃整块：压在那段区间上的格子不换，别的照换。
         `radiance` 里那条 `ARGMEM %0 48` 从前一个人摁死 0 号帧块的全部 321 条访存。 */
      if ((op === OP.ARGMEM || op === OP.ARGSRET) && u.role === 'a') {
        const a = addrOf(fn, mod, fn.a[u.pc]);
        const size = memArgSize(fn.aux[u.pc]);
        if (a.base !== base || size <= 0) return no(`%${u.pc} ${OP_NAMES[op]} 盖住哪几个字节说不清`);
        escapes.push({ lo: a.off, hi: a.off + size });
        continue;
      }
      /* 三之二、`RET 这个地址` = **返回一整块 struct**，同样只逃逸它盖住的那几个字节：
         后端照**返回类型的大小**读一次就完（`from_mir.js` 的 `OP.RET`：arm64 上 ≤16 字节
         装进 x0/x1 或 d0-d3；>16 字节那条路 RET 带的是调用方给的 x8 缓冲，不是我们的块）。
         与 `ARGMEM` 那一条同一个判据 —— 字节数由 ABI 定死。

         为什么要这一条（量出来的）：C 前端给一个函数只划**一整块** `$frame`，返回值的临时
         与别的聚合局部量挤在一起。`Tree__search` 里 `OMNI_SROA_STAT` 报的正是
         `放弃 %0（%120 RET 的 a）` —— 那一条把整块 47 条候选全摁死，而它真正碰到的
         只有返回值那 16 个字节。 */
      if (op === OP.RET && u.role === 'a') {
        const a = addrOf(fn, mod, fn.a[u.pc]);
        const size = memArgSize(fn.retStruct);
        if (a.base !== base || size <= 0) return no(`%${u.pc} RET 盖住哪几个字节说不清`);
        escapes.push({ lo: a.off, hi: a.off + size });
        continue;
      }
      /* 四、`STORE 这个地址 -> 一个从头到尾没人 LOAD 的槽`：**不算逃逸**。
         那条 STORE 写进去的东西观察不到，地址没跑出去。
         为什么非认这一种不可（量出来的）：`inline` 把 `RET v` 铺成
         `STORE v -> 结果槽; BR`，结果槽被 mem2reg 提升之后那条 STORE 还在，
         而收它的 `elim unread autos` 在通道表里排在这一格**后面**（第 46 格 vs 第 12/28 格）。
         不认这一种，`sph_intersect` 里按值收的那份 `Ray` 拷贝就永远拆不开 ——
         它的地址正好被那么一条死 STORE 攥着。 */
      if (op === OP.STORE && u.role === 'a' && !unreadSlots.has(fn.aux[u.pc])) {
        /* 还有人读那个槽 ⇒ 先试着把"它能碰到哪几个字节"算出来（见 `slotEscapes`）。
           算出来了就只让那几个格子不换，块里别的照拆。 */
        const es = slotEscapes(fn, mod, base, fn.aux[u.pc], sites);
        if (es !== null) { for (const e of es) escapes.push(e); continue; }
        /* `OMNI_SROA_STAT=1` 时把那个槽的读处与写处一并印出来 —— 这一条是最难查的一道闸，
           只报槽号看不出是"跨了区域边界的 phi"还是"真把地址交出去了"。 */
        let why = `%${u.pc} 把地址存进了还有人读的 slot${fn.aux[u.pc]}`;
        if (stat) {
          const rd = [];
          for (let q = 0; q < fn.op.length; q++) {
            if (fn.op[q] === OP.LOAD && fn.aux[q] === fn.aux[u.pc]) rd.push(`%${q}`);
          }
          why += `（读它的：${rd.slice(0, 8).join(' ')}${rd.length > 8 ? ' …' : ''}`;
          const wr = [];
          for (let q = 0; q < fn.op.length; q++) {
            if (fn.op[q] === OP.STORE && fn.aux[q] === fn.aux[u.pc]) {
              const v = fn.a[q];
              wr.push(`%${q}<-${v >= REF_BIAS ? `%${v - REF_BIAS} ${OP_NAMES[fn.op[v - REF_BIAS]]}` : `k${v}`}`);
            }
          }
          why += `；写它的：${wr.slice(0, 8).join(' ')}${wr.length > 8 ? ' …' : ''}）`;
        }
        return no(why);
      }
      if (op === OP.STORE && u.role === 'a') continue;
      /* 别的一律算"说不清范围的逃逸" —— 放弃整块。
       *
       * ⚠️ **裸指针实参（`CALL f(…, 这个地址, …)`）试过一刀，撤了**：想法是问被调
       * "你通过那个形参碰哪几个字节"（`intersect(r, &t)` 里的 `&t` 只有 8 个字节，
       * 从前它一个人摁死 0 号帧块另外三百多条访存）。写出来之后 `tests/mir/opt.js`
       * **卡死**（判据跑不完），所以按纪律撤回 —— 没量过的一刀不许留在主干上。
       * 下次要做的话，先把两处会爆的地方定住：
       *   - `slotEscapes` / 跨函数那一版都在做**叉乘**（每个存进去的偏移 × 每个访问的偏移），
       *     再加上后面 `cells × escapes` 那一趟，radiance 的 0 号帧块上就是几十万级；
       *   - `paramRange` 的缓存要按"被调的指令条数"判过期（管线跑两遍 SROA，被调会变）。
       */
      return no(`%${u.pc} ${OP_NAMES[op]} 的 ${u.role}`);
    }
  }
  return true;
}

/** 两个格子部分重叠吗（完全相同不算）。 */
function partialOverlap(x, y) {
  if (x.lo === y.lo && x.hi === y.hi) return false;
  return x.lo < y.hi && y.lo < x.hi;
}

/** 这一对（读的宽度符号、写的宽度符号）是"读回来就是写进去那个值"吗。
 *  与 `memory.js` 的 `sameCell` 认的是同四对：i64/i32s/f32/f64。 */
function kindPairOk(loadKind, storeKind) {
  const ln = MLOAD_KINDS[loadKind], sn = MSTORE_KINDS[storeKind];
  return (ln === 'i64' && sn === 'i64')
      || (ln === 'i32s' && sn === 'i32')
      || (ln === 'f32' && sn === 'f32')
      || (ln === 'f64' && sn === 'f64');
}

/**
 * 一个 base ref 的**别名身份**（同一个身份 = 同一块内存）。认不出来就回 ''。
 *
 * 这一格是第一版的 bug 所在：那时按 **ref** 分组，而同一块内存在一个函数里会有
 * **好几个 ref** —— `FRAME 0` 是一条普通指令，前端每用一次就发一条，两条 `FRAME 0`
 * 指的是同一块。按 ref 分组于是给同一块字节开了两套槽位，两套各自记各自的值。
 * 判据当场骂（`tests/mir/opt.js` 的 L1 里 04-pointer / 07-struct / 12-struct-abi …
 * 十几份对不上），所以这儿按**身份**分组：
 *
 *   - `FRAME`（**原生腿上局部量的那一块**）：身份 = 帧块号
 *   - 别的一概不碰。特别是**线性内存的影子栈**（`SUB(GLOAD $sp, k)`）：那是 wasm/js/
 *     解释器那几条腿的事（C 与线性内存无关 —— 原生腿上 `FRAME` 给的是真地址），
 *     而且 `$sp` 在函数体里会被重新赋值，于是"同一个全局减同一个常量"**不保证是同一块**
 *     （嵌套作用域各分一次）。少认一类，少一类别名风险。
 *   - 认不出的那些（malloc 回来的指针、形参里的指针…）**不会**与 `FRAME` 那几块别名：
 *     一块要被指针碰到，它的地址得先逃逸，而地址一逃逸我们就整块放弃（见 `scanBase`）。
 */
function aliasId(fn, mod, ref) {
  if (ref === REF_NONE || ref < REF_BIAS) return '';
  const pc = ref - REF_BIAS;
  if (fn.op[pc] === OP.FRAME) return `F${fn.aux[pc]}`;
  return '';
}

/**
 * 跑 SROA。回换了几条访存。
 */
export function sroa(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const sites = useSites(fn);
  /* 哪些槽**从头到尾没人真读** —— 往那种槽里写什么都观察不到（见 `scanBase` 第四条）。
     判据是"有没有一条 LOAD 的**结果被人引用**"，不是"有没有一条 LOAD 指令"：
     mem2reg 只改引用、**一条指令都不删**（见 ssa.js 顶上那段），所以它转发掉的那些
     LOAD 还摆在指令数组里，等紧跟的 deadcode 收。按"指令在不在"判就会把一个
     已经没人读的槽当成"还有人读"，整块访存于是白白留在内存上。 */
  const loaded = new Set();
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] === OP.LOAD && sites.has(REF_BIAS + pc)) loaded.add(fn.aux[pc]);
  }
  const unread = new Set();
  for (let i = 0; i < fn.slots.length; i++) if (!loaded.has(i)) unread.add(i);

  /* 一、把所有访存的 base 按**别名身份**归堆（见 `aliasId`） */
  const groups = new Map();      // 身份 -> [base ref…]
  for (let pc = 0; pc < fn.op.length; pc++) {
    const op = fn.op[pc];
    if (op !== OP.MLOAD && op !== OP.MSTORE) continue;
    const a = addrOf(fn, mod, fn.a[pc]);
    const id = aliasId(fn, mod, a.base);
    if (id === '') continue;
    let l = groups.get(id);
    if (l === undefined) { l = []; groups.set(id, l); }
    if (l.indexOf(a.base) < 0) l.push(a.base);
  }
  if (groups.size === 0) return 0;

  let changed = 0;
  const stat = process.env.OMNI_SROA_STAT === '1';
  for (const bases of groups.values()) {
    /* 这一堆里每个 base 各扫一遍，格子与逃逸区间都并进同两个容器。
       只有"说不清盖住哪儿"的逃逸才放弃整堆。 */
    const all = new Map();
    const escapes = [];
    let ok = true;
    for (const base of bases) {
      if (!scanBase(fn, mod, base, sites, unread, all, escapes)) { ok = false; break; }
    }
    if (!ok) continue;
    const cells = [];
    for (const c of all.values()) cells.push(c);
    if (cells.length === 0) continue;
    /* 后面这几道的放弃也要能看见（`OMNI_SROA_STAT=1`）—— 从前只有 `scanBase` 里那几条
     * 会印，于是"321 条访存在 FRAME 块上、可 scanBase 只拒了 2 个"这件事查不下去。 */
    const drop = (c, why) => {
      if (stat && !c.bad) process.stderr.write(`[sroa] ${fn.name}: 格子 ${c.lo}|${c.hi} 不换（${why}）\n`);
      c.bad = true;
    };
    /* 一、压在逃逸区间上的格子不换（被调方能碰到那几个字节） */
    for (const c of cells) {
      for (const e of escapes) {
        if (c.lo < e.hi && e.lo < c.hi) { drop(c, `落在逃逸区间 ${e.lo}|${e.hi} 上`); break; }
      }
    }
    /* 二、部分重叠的两格都不换（`char` view 一个 `int` 那种）。
       按 lo 排好序只比"还压得上的那几个"，免得在大帧块上退化成 O(n²)。 */
    cells.sort((x, y) => (x.lo - y.lo) || (x.hi - y.hi));
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length && cells[j].lo < cells[i].hi; j++) {
        if (partialOverlap(cells[i], cells[j])) {
          drop(cells[i], `与 ${cells[j].lo}|${cells[j].hi} 部分重叠`);
          drop(cells[j], `与 ${cells[i].lo}|${cells[i].hi} 部分重叠`);
        }
      }
    }
    /* 三、每个格子还要过两道（少一道就会悄悄改语义）：
       1. **读写必须同宽、而且是那个类型的全宽**：存 i32 再按 `i8s` 读回来是"那个字节的
          符号扩展"，槽位装不出这件事（与 `memory.js` 的 `sameCell` 同一条判据）；
       2. **必须至少写过一次**：只读的格子读的是没初始化的内存（C 里是未定义行为），
          换成槽位之后读到的是槽位的初值 —— 两者可能不同。 */
    for (const c of cells) {
      if (c.bad) continue;
      if (c.storeKind < 0) { drop(c, '只读没写过'); continue; }
      if (c.loadKind >= 0 && !kindPairOk(c.loadKind, c.storeKind)) {
        drop(c, `读写宽度对不上（读 ${c.loadKind} 写 ${c.storeKind}）`);
      }
    }

    /* 四、一个格子一个槽，然后就地换 op */
    for (const c of cells) {
      if (c.bad) continue;
      const no = fn.slot(`sroa@${c.lo}`, c.t);
      for (const pc of c.pcs) {
        if (fn.op[pc] === OP.MLOAD) {
          fn.op[pc] = OP.LOAD;
          fn.a[pc] = REF_NONE;
          fn.aux[pc] = no;
        } else {
          fn.op[pc] = OP.STORE;
          fn.a[pc] = fn.b[pc];        // 值挪到 a（STORE 的形状是 `a -> aux 号槽`）
          fn.b[pc] = REF_NONE;
          fn.aux[pc] = no;
        }
        changed++;
      }
    }
  }
  return changed;
}

registerPass('decompose user', sroa);
/**
 * **再跑一遍** —— 照 Go 的 `ssacompile/expand_calls.go:20`：
 *
 *     func postExpandCallsDecompose(f *ssa.Func) {
 *       decomposeUser(f)    // redo user decompose to cleanup after expand calls
 *       decomposeBuiltin(f) // handles both regular decomposition and cleanup.
 *     }
 *
 * 那是 `expand calls` 那一格自己收尾时调的，位置就在通道表 `expand calls` /
 * `decompose builtin` 这两行上。**Go 的 `decomposeUser` 确实跑两遍**，不是我们加的。
 *
 * 为什么这一遍能拆掉第一遍拆不掉的（量出来的）：第一遍在 `opt` 之前，那时按值实参的
 * 临时块上「同一格存的是 i64、读的是 f64」（C 前端的拷贝按字拷，不看字段类型），
 * `scanBase` 在「同一格两种类型：不碰」那一行就退了。`opt`/`middle opt` 里的
 * `copyfwd.js`（`generic.rules:865`）把那些 f64 读改成直接读源头之后，
 * 块上只剩清一色的 i64 存取 —— 这一遍就拆得动了，拆出来的槽没人读，
 * 交给 `dead auto elim` 与 `elim unread autos` 收。
 */
registerPass('decompose builtin', sroa);
