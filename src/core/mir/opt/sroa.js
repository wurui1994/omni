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
 * 判"不逃逸"的白名单（**名单之外一律放弃整个 base**）
 * -------------------------------------------------
 *   - 当 `MLOAD`/`MSTORE` 的**地址**用（`a` 那一格）
 *   - 当 `ADD(base, 整数常量)` 的操作数用（那还是个地址，接着往下查）
 * 别的（进实参池、被存进内存、当返回值…）一律算逃逸。
 */

import {
  OP, OP_MODES, OP_NAMES, REF_BIAS, REF_NONE,
  MLOAD_BYTES, MSTORE_BYTES, MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff,
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
 * 查一个 base：它派生出来的地址都只当访存的地址用吗。
 * 回 `{ok, cells}`；`cells` 是 `Map(键 -> {lo, hi, t, kind, pcs})`，键是 `lo|hi`。
 */
function scanBase(fn, mod, base, sites, unreadSlots) {
  const cells = new Map();
  const seen = new Set();
  const work = [base];
  /* `OMNI_SROA_STAT=1`：**为什么放弃这一块**。逃逸判据是这一格唯一的闸，判紧一处
   * 整块访存就都收不掉，所以要能一眼看见原因（量过再改，别猜）。 */
  const no = (why) => {
    if (process.env.OMNI_SROA_STAT === '1') {
      process.stderr.write(`[sroa] ${fn.name}: 放弃 %${base - REF_BIAS}（${why}）\n`);
    }
    return { ok: false };
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
          c = { lo, hi, t: fn.t[u.pc], loadKind: -1, storeKind: -1, pcs: [] };
          cells.set(key, c);
        }
        if (c.t !== fn.t[u.pc]) return no(`格子 ${key} 上两种类型`);
        if (isLoad) { if (c.loadKind >= 0 && c.loadKind !== k) return no(`格子 ${key} 两种读宽`); c.loadKind = k; }
        else { if (c.storeKind >= 0 && c.storeKind !== k) return no(`格子 ${key} 两种写宽`); c.storeKind = k; }
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
      /* 三、`STORE 这个地址 -> 一个从头到尾没人 LOAD 的槽`：**不算逃逸**。
         那条 STORE 写进去的东西观察不到，地址没跑出去。
         为什么非认这一种不可（量出来的）：`inline` 把 `RET v` 铺成
         `STORE v -> 结果槽; BR`，结果槽被 mem2reg 提升之后那条 STORE 还在，
         而收它的 `elim unread autos` 在通道表里排在这一格**后面**（第 46 格 vs 第 12/28 格）。
         不认这一种，`sph_intersect` 里按值收的那份 `Ray` 拷贝就永远拆不开 ——
         它的地址正好被那么一条死 STORE 攥着。 */
      if (op === OP.STORE && u.role === 'a' && !unreadSlots.has(fn.aux[u.pc])) {
        return no(`%${u.pc} 把地址存进了还有人读的 slot${fn.aux[u.pc]}`);
      }
      if (op === OP.STORE && u.role === 'a') continue;
      /* 别的一律算逃逸 */
      return no(`%${u.pc} ${OP_NAMES[op]} 的 ${u.role}`);
    }
  }
  return { ok: true, cells };
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
  /* 哪些槽**从头到尾没人 LOAD** —— 往那种槽里写什么都观察不到（见 `scanBase` 第三条）。 */
  const loaded = new Set();
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] === OP.LOAD) loaded.add(fn.aux[pc]);
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
  for (const bases of groups.values()) {
    /* 这一堆里每个 base 各扫一遍，格子并起来。任何一个 base 上有逃逸 ⇒ 整堆放弃。 */
    const all = new Map();
    let ok = true;
    for (const base of bases) {
      const r = scanBase(fn, mod, base, sites, unread);
      if (!r.ok) { ok = false; break; }
      for (const [key, c] of r.cells) {
        const got = all.get(key);
        if (got === undefined) { all.set(key, c); continue; }
        /* 同一个格子从两个 base ref 上访问：并起来，类型/宽度要一致 */
        if (got.t !== c.t) { ok = false; break; }
        if (c.loadKind >= 0) { if (got.loadKind >= 0 && got.loadKind !== c.loadKind) { ok = false; break; } got.loadKind = c.loadKind; }
        if (c.storeKind >= 0) { if (got.storeKind >= 0 && got.storeKind !== c.storeKind) { ok = false; break; } got.storeKind = c.storeKind; }
        for (const pc of c.pcs) got.pcs.push(pc);
      }
      if (!ok) break;
    }
    if (!ok) continue;
    const cells = [];
    for (const c of all.values()) cells.push(c);
    if (cells.length === 0) continue;
    /* 后面这几道的放弃也要能看见（`OMNI_SROA_STAT=1`）—— 从前只有 `scanBase` 里那几条
     * 会印，于是"321 条访存在 FRAME 块上、可 scanBase 只拒了 2 个"这件事查不下去。 */
    const stat = process.env.OMNI_SROA_STAT === '1';
    const nope = (why) => { if (stat) process.stderr.write(`[sroa] ${fn.name}: 放弃一堆（${why}）\n`); };
    /* 部分重叠的格子（`char` view 一个 `int` 那种）一律放弃这一堆 */
    let bad = false;
    for (let i = 0; i < cells.length && !bad; i++) {
      for (let j = i + 1; j < cells.length && !bad; j++) {
        if (partialOverlap(cells[i], cells[j])) { bad = true; nope(`格子部分重叠 ${cells[i].lo}|${cells[i].hi} 与 ${cells[j].lo}|${cells[j].hi}`); }
      }
    }
    if (bad) continue;
    /* 每个格子还要过两道（少一道就会悄悄改语义）：
       1. **读写必须同宽、而且是那个类型的全宽**：存 i32 再按 `i8s` 读回来是"那个字节的
          符号扩展"，槽位装不出这件事（与 `memory.js` 的 `sameCell` 同一条判据）；
       2. **必须至少写过一次**：只读的格子读的是没初始化的内存（C 里是未定义行为），
          换成槽位之后读到的是槽位的初值 —— 两者可能不同，所以这种 base 整个放弃。 */
    for (const c of cells) {
      if (c.storeKind < 0) { bad = true; nope(`格子 ${c.lo}|${c.hi} 只读没写过`); break; }
      if (c.loadKind >= 0 && !kindPairOk(c.loadKind, c.storeKind)) {
        bad = true; nope(`格子 ${c.lo}|${c.hi} 的读写宽度对不上（读 ${c.loadKind} 写 ${c.storeKind}）`); break;
      }
    }
    if (bad) continue;

    /* 二、一个格子一个槽，然后就地换 op */
    for (const c of cells) {
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
