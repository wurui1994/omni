/**
 * mem2reg —— 把不取地址的 SLOT 的读**改成直接引用那个值**（块内 SSA 化）。
 *
 * MIR 里可变局部量是 `SLOT + LOAD/STORE`（ir.js 第 1 条决策）。这一格把**不取地址的**
 * SLOT 在**块内**做值传播：连着的 `STORE s, v ; … ; LOAD s` 变成直接引用 `v`。
 *
 * 取地址的 SLOT（被 `FRAME` 指向、之后再 `MLOAD`/`MSTORE`）留着不动。
 * 跨块的合流（需要 phi）第一版也留着不动——那些 LOAD 照旧走 SLOT，正确但不优化。
 *
 * ⚠️ **这一格只改"谁引用谁"，一条指令都不删**。
 *    第一版试过把消掉的 LOAD/STORE 改写成 `END`，被 verifier 当场抓住：
 *    MIR 的 `END` **不是空操作**，它关掉最近一个未闭合的区域 ——
 *    改完之后 `sum` 里报"END 没有对应的区域"、"BR 跳 0 层但此处只有 0 层可跳"，
 *    解释器直接抛"BR 跳出了函数"。MIR 里**没有 NOP**，所以删指令这件事要等
 *    `early deadcode` 那一格（它会重建指令数组并重编号 ref）。
 *    这也正是 Go 的通道表在每个变换之后都紧跟一格 deadcode 的理由。
 *
 * 注册到 `early phielim and copyelim` —— Go 通道表里这是第一格有用的通道，位置对得上。
 */

import { OP, REF_BIAS } from '../ir.js';
import { buildCfg, reachable } from './cfg.js';
import { inScope, regionScope } from './region.js';
import { replaceRef } from './edit.js';
import { registerPass } from './pass.js';

/** 这个 ref 在 `pc` 那儿看得见吗（常量永远看得见；指令要问词法作用域）。 */
function usableHere(sc, fn, ref, pc) {
  if (ref < REF_BIAS) return true;
  return inScope(sc, ref - REF_BIAS, pc);
}

/**
 * 哪些 slot **不能**提升（地址被取过）。
 *
 * 答案是**一个都没有**，而这不是乐观，是 MIR 的角色表定的事实：
 * 整张 `OP_MODES` 里带 `'s'`（槽号）角色的只有两条 —— `LOAD` 与 `STORE`。
 * **没有任何一条 op 能拿到一个槽的地址**。取过地址的局部量由 C 前端放进
 * `FRAME` 块（另一片存储，靠 `MLOAD`/`MSTORE` 访问），压根不占槽。
 *
 * 曾经这儿是「函数里只要出现过一条 `FRAME`，就把**所有**槽标成地址已取」，
 * 注释写着"第二批再做精确的"。那一刀的代价是量出来的：`sph_intersect`
 * （smallpt 自时间的 47%）里有一条 `FRAME`（按值收的 `Ray r` 那份拷贝），
 * 于是 **mem2reg 在它身上整个是个空操作** —— 内联进来的 `vsub$a`/`vsub$b`/`$sret`
 * 那些槽一个都没提升，帧块的地址经过槽兜了一圈，`copyfwd.js` 与 `sroa.js`
 * 两格都判它逃逸、都不敢动。smallpt 的整条热路径都栽在这一行上。
 *
 * 留这个函数（而不是把调用点删了）是为了这段说明有个落脚处：将来 MIR 真加了
 * 「取槽地址」那一条 op，这儿就是该改的地方。
 */
function addressTakenSlots(_fn) {
  return new Set();
}

/**
 * 就地 mem2reg。回改了几条指令（0 = 这个函数没活可做）。
 *
 * 做法：块内遍历，对每个 promotable slot 维护"当前值"。
 *   STORE s, v → 记 cur[s] = a（v 是写进去的值），STORE 变 END（块内的空操作）
 *   LOAD  s    → 如果 cur[s] 有值，就把**所有引用 %pc 的地方**换成 cur[s]，LOAD 变 END
 *   块结束     → 如果后继只有一个前驱，把 cur 传过去（dominator tree 的直接子 + 唯一前驱 = 安全）
 *
 * END 在块中间语义上是"无"（MIR 的 END 只对区域标记有意义，不在 IF/LOOP 里的 END
 * 什么都不做，后端会跳过它）。
 */
export function mem2reg(fn, _mod) {
  if (!fn || fn.slots.length === 0) return 0;

  const taken = addressTakenSlots(fn);
  const promotable = new Set();
  for (let i = 0; i < fn.slots.length; i++) {
    if (!taken.has(i)) promotable.add(i);
  }
  if (promotable.size === 0) return 0;

  const cfg = buildCfg(fn);
  if (cfg.blocks.length === 0) return 0;
  const reach = reachable(cfg);
  /* 词法作用域（`region.js`）：跨块传值的时候必须问一句"那个定义在这儿还看得见吗"。
     少这一问的后果见 cse.js 里那段 —— 循环之前定义的值传到循环之后去用，
     verifier 骂「定义在一个已经关掉的区域里」。 */
  const sc = regionScope(fn);

  /* 每个块入口时各 slot 的值。`UNKNOWN` = 还不知道 ⇒ LOAD 留着不动，走 SLOT。
     ⚠️ 这里存的是 **ref**（`REF_BIAS + 指令下标` 或常量号），不是裸的 pc ——
     第一版把 `pc` 和 ref 混用了，于是 replaceRef 找不到任何一处（改写 0 处、白跑一趟）。 */
  const UNKNOWN = -1;
  const REF_NONE = UNKNOWN;
  const entryCur = [];
  for (let i = 0; i < cfg.blocks.length; i++) {
    const m = {};
    for (const s of promotable) m[s] = UNKNOWN;
    entryCur.push(m);
  }
  /* 形参初始化（形参是入口块开始时各 slot 的初始定义）*/
  for (const p of fn.params) {
    if (promotable.has(p.slot)) {
      // 形参本身没有一条"定义指令"，但**它就是那个 slot 的初始值**。
      // 这儿不能直接把 LOAD 消掉，因为形参没有 ref 可以指过去。
      // 安全做法：设 cur[slot] = UNKNOWN（留着 LOAD，不消）。
      // 以后加了"形参 = %0 那格的隐含定义"再改。
    }
  }

  let changed = 0;
  /**
   * ---- 一、**先把每个块的出口值算到不动点**（这就是 Go 的 `phielim`）。
   *
   * `ssacompile/phielim.go`：「A phi is redundant if its arguments are all equal.」
   * 我们没有 phi，等价的说法是：**一个块的多个前驱在某个 slot 上给出同一个 ref**，
   * 那这个块入口处这个 slot 就是那个 ref。前驱们给的不一样、或者哪个还不知道，
   * 就是 `UNKNOWN`（那条 LOAD 留着）。
   *
   * 为什么非要这一步：内联把 `RET v` 铺成 `STORE v -> 结果槽; BR ^depth`，一条 `RET`
   * 就是一个前驱。`vsub` 那种单出口函数内联进来之后结果槽有两条一模一样的 STORE
   * （尾部那一段复制出来的），两个前驱写的是同一个 ref —— 少了这一问，
   * `LOAD 结果槽` 就永远提升不掉，帧块的地址于是经过槽兜一圈，
   * `copyfwd.js`/`sroa.js` 判它逃逸（量出来：sph_intersect 的 88 条访存一条都收不掉）。
   *
   * 起点一律 `UNKNOWN`、`meet(UNKNOWN, x) = UNKNOWN`：这是**悲观**起点，所以回边
   * （循环）上永远停在 UNKNOWN，不会把一个乐观的值传出循环去。安全。
   */
  const exitCur = [];
  for (let i = 0; i < cfg.blocks.length; i++) exitCur.push(null);
  const runBlock = (bb, cur) => {
    for (let pc = bb.from; pc <= bb.to; pc++) {
      const op = fn.op[pc];
      if (op === OP.STORE && promotable.has(fn.aux[pc])) { cur[fn.aux[pc]] = fn.a[pc]; continue; }
      if (op === OP.LOAD && promotable.has(fn.aux[pc])) {
        if (cur[fn.aux[pc]] === UNKNOWN) cur[fn.aux[pc]] = REF_BIAS + pc;
        continue;
      }
    }
    return cur;
  };
  for (let round = 0; round < cfg.blocks.length + 1; round++) {
    let moved = false;
    for (const bb of cfg.blocks) {
      if (!reach.has(bb.id)) continue;
      exitCur[bb.id] = runBlock(bb, Object.assign({}, entryCur[bb.id]));
    }
    for (const bb of cfg.blocks) {
      if (!reach.has(bb.id)) continue;
      const preds = cfg.blocks[bb.id].pred;
      if (preds.length === 0) continue;
      for (const s of promotable) {
        let v = UNKNOWN;
        let first = true;
        for (const p of preds) {
          /* **到不了的前驱不算**：它的出口值永远是 null，算进来会把 meet 毒成 UNKNOWN。
             内联把尾部复制了一份（`STORE 结果槽; BR` 两遍），后一份就是到不了的那种。 */
          if (!reach.has(p)) continue;
          const e = exitCur[p];
          const pv = (e === undefined || e === null) ? UNKNOWN : e[s];
          if (first) { v = pv; first = false; continue; }
          if (pv !== v) v = UNKNOWN;
        }
        if (v !== UNKNOWN && entryCur[bb.id][s] !== v) { entryCur[bb.id][s] = v; moved = true; }
      }
    }
    if (!moved) break;
  }

  /* ---- 二、按算好的入口值改引用 */
  for (const bb of cfg.blocks) {
    if (!reach.has(bb.id)) continue;
    const cur = Object.assign({}, entryCur[bb.id]);

    for (let pc = bb.from; pc <= bb.to; pc++) {
      const op = fn.op[pc];

      if (op === OP.STORE && promotable.has(fn.aux[pc])) {
        /* 写：只记下"这个 slot 现在是哪个值"。**STORE 一条不动** ——
           要删它得先证明这个 slot 再也没人读，那是 dse / dead auto elim 的活。 */
        cur[fn.aux[pc]] = fn.a[pc];
        continue;
      }

      if (op === OP.LOAD && promotable.has(fn.aux[pc])) {
        const v = cur[fn.aux[pc]];
        const myRef = REF_BIAS + pc;          // 这条 LOAD 的结果的 ref
        if (v !== UNKNOWN && v !== myRef && usableHere(sc, fn, v, pc)) {
          /* 有定义且在这儿看得见 ⇒ 把所有引用 %pc 的地方改成引用 v。
             LOAD 本身留着（没人引用了，deadcode 那格会删）。 */
          changed += replaceRef(fn, myRef, v);
        }
        /* v === UNKNOWN：入口没定义 ⇒ 这条 LOAD 就是这个 slot 在本块的第一个定义 */
        if (v === UNKNOWN) cur[fn.aux[pc]] = myRef;
        continue;
      }
    }
  }
  return changed;
}

/** 把 fn 里**所有** a/b/实参池里引用 oldRef 的地方换成 newRef —— 见 `edit.js`。 */

registerPass('early phielim and copyelim', mem2reg);
