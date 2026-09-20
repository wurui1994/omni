/**
 * dse —— 死存储消除。照 Go 的 `ssacompile/deadstore.go:23 dse`：
 *
 *   「死存储 = **无条件地**被另一条写同一处的存储盖掉，中间没有读。
 *     This implementation only works within a basic block.」
 *
 * 块内 = 直线代码，所以"无条件"这件事不用算支配：同一个块里后面那条一定会执行。
 * 我们照它只做块内（它自己的 TODO 也还挂着）。
 *
 * MIR 上有**两族**存储，判据不同：
 *
 * 1. `STORE`（槽位）—— **精确**。op 表里角色 's' 只出现在 `LOAD`/`STORE` 的 aux 上，
 *    没有任何 op 能取槽位的地址，所以"中间有没有读"只要问有没有 `LOAD 同一个槽`；
 *    连调用都读不到槽位。
 * 2. `MSTORE`（**按地址写内存**：原生腿上是真地址，wasm/js/解释器那几条腿上是线性内存的
 *    字节）—— 判"同一处"靠 `memory.js` 的
 *    `cellOf`/`sameSpot`：地址拆成 `{基址, 静态偏移}`（`ADD(base, 常量)`，就是 Go 的
 *    `OffPtr`），再比字节区间。中间一条**可能读内存**的指令都不许有。
 *    `MSTORE`/`PSTORE`/`STORE`/`GSTORE` 自己不读，所以它们不打断（Go 的
 *    `deadstore.go:56` 那句注释是同一件事："These ops never read from their memory input"）。
 *
 * 为什么"地址逃逸了"不影响正确性：这一格只在**后面有一条写同一处**的时候删前一条，
 * 那块地方反正会被写上新值 —— 与谁拿着它的地址无关。
 *
 * 删指令走 `edit.js` 的 `removeInsns`（MIR 里没有 NOP）。
 */

import { OP } from '../ir.js';
import { buildCfg } from './cfg.js';
import { mayReadMemory, cellOf, sameSpot } from './memory.js';
import { removeInsns } from './edit.js';
import { registerPass } from './pass.js';

/**
 * 跑 dse。回删了几条。
 */
export function dse(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  const cfg = buildCfg(fn);
  if (cfg.blocks.length === 0) return 0;
  const doomed = new Set();

  for (const bb of cfg.blocks) {
    /* **从后往前**走：`killed` = "这处后面已经有一条写了、中间没有读"。 */
    const slotKilled = new Set();
    const memKilled = [];        // 后面已经被盖掉的那些字节区间（cellOf 的形状）
    for (let pc = bb.to; pc >= bb.from; pc--) {
      const op = fn.op[pc];
      if (op === OP.STORE) {
        const s = fn.aux[pc];
        if (slotKilled.has(s)) doomed.add(pc); else slotKilled.add(s);
        continue;
      }
      if (op === OP.LOAD) { slotKilled.delete(fn.aux[pc]); continue; }
      /* `SETJMP`/`LONGJMP`：控制流会**跳回**这一点（C11 7.13 的"回来两次"）。
         落点就在 SETJMP 之后，所以后面那条写照旧会跑、判据其实仍成立 ——
         但这一格便宜，清干净不留想象空间。 */
      if (op === OP.SETJMP || op === OP.LONGJMP) { slotKilled.clear(); memKilled.length = 0; continue; }
      if (op === OP.MSTORE) {
        const cell = cellOf(fn, mod, pc, false);
        let dead = false;
        for (const k of memKilled) if (sameSpot(cell, k)) { dead = true; break; }
        if (dead) doomed.add(pc); else memKilled.push(cell);
        continue;
      }
      if (mayReadMemory(op)) memKilled.length = 0;
    }
  }

  /* STORE/MSTORE 都不产值（t = void），所以删它们不会留下悬空 ref；
     真留下了 removeInsns 会当场炸。 */
  return removeInsns(fn, doomed);
}

registerPass('dse', dse);

