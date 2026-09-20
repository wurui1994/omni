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

/** 有 FRAME 出现的函数里保守地把所有 slot 标为地址已取。
 *  更精确的：追 FRAME → MLOAD/MSTORE 的定义-使用链，只标真被取过地址的。第二批再做。 */
function addressTakenSlots(fn) {
  const taken = new Set();
  let hasFrame = false;
  for (let pc = 0; pc < fn.op.length; pc++) {
    if (fn.op[pc] === OP.FRAME) hasFrame = true;
  }
  if (hasFrame) for (let i = 0; i < fn.slots.length; i++) taken.add(i);
  return taken;
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
          /* 块内有定义 ⇒ 把所有引用 %pc 的地方改成引用 v。
             LOAD 本身留着（没人引用了，deadcode 那格会删）。 */
          changed += replaceRef(fn, myRef, v);
        }
        /* v === REF_NONE：块入口没定义 ⇒ 这条 LOAD 就是这个 slot 在本块的第一个定义 */
        if (v === UNKNOWN) cur[fn.aux[pc]] = myRef;
        continue;
      }
    }

    /* 把 cur 传给"唯一前驱就是我"的后继。
       ⚠️ 必须同时问 `pred[0] === bb.id`：只问"前驱只有一个"会在 CFG 少一条边的时候
       把值传到一个其实另有来路的块里 —— `tests/c/gen/10-switch.c` 上量到过
       （那时 buildCfg 还不认 BRTABLE，switch 的目标块看起来都只有一个前驱，s=7457 变 7557）。 */
    for (const sid of cfg.blocks[bb.id].succ) {
      const sp = cfg.blocks[sid].pred;
      if (sp.length === 1 && sp[0] === bb.id) {
        for (const s of promotable) {
          if (cur[s] !== UNKNOWN) entryCur[sid][s] = cur[s];
        }
      }
    }
  }
  return changed;
}

/** 把 fn 里**所有** a/b/实参池里引用 oldRef 的地方换成 newRef —— 见 `edit.js`。 */

registerPass('early phielim and copyelim', mem2reg);
