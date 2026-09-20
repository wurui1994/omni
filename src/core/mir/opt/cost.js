/**
 * 成本模型 —— **这一层唯一的"划得来吗"判据**：别把活跃区间跨过屏障拉长。
 *
 * 为什么要有它（量出来的，不是想出来的）
 * ------------------------------------
 * 两条 native 后端各有一个一遍过的值缓存（`arm64/from_mir.js` 的 `POOL`：五个
 * 调用者保存的寄存器）。它在**控制流一分岔/一合并、或者一条 `bl` 之前**必须把攥着的值
 * 全写回"值的栈位"（`flush`）—— 那五个跨不过一次调用。
 *
 * 于是这一层每一次"把两处合成一处"（mem2reg 的转发、存储转发、CSE）都有两面：
 *   - 好的一面：少一条 `ldr`（或少一次重算）
 *   - 坏的一面：那个值的区间变长；只要跨过一个屏障，后端就得**多一对 `str`+`ldr`**
 *
 * 量出来的账（`/tmp/abx.mjs` 交错取最小，fib(27) × 3 —— call-heavy 的那一类）：
 *   不优化 5.3ms；**只跑 mem2reg + deadcode 6.9ms（×1.31）**；只跑 opt 5.2ms
 * 也就是说"指令条数降了 12%"的同一份代码在真机上慢了三成。ADR-0039 第 8 节那句
 * 「别再拿指令条数当性能判据」就是这么来的。
 *
 * 所以：**跨屏障的合并一律不做**，那条 `ldr` 留着 —— 从槽/内存里重读一次正是"重算"
 * （rematerialization），Go 的分配器也偏向这一手（它的 `rematerializeable`）。
 *
 * 等有了会溢出的真分配器（能自己决定谁住寄存器、谁回内存、在哪儿切区间），
 * 这一格该重新量一遍：那时"跨屏障"就不再自动等于"亏"。
 */

import { OP } from '../ir.js';

/** 后端的值缓存在这条指令上活不过去。 */
export function isBarrier(op) {
  return op === OP.BLOCK || op === OP.LOOP || op === OP.IF || op === OP.ELSE || op === OP.END
      || op === OP.BR || op === OP.BRIF || op === OP.BRTABLE || op === OP.RET
      || op === OP.CALL || op === OP.CALLFN || op === OP.CALLOP || op === OP.CCALL
      || op === OP.CALLI || op === OP.SYSCALL || op === OP.SYSCALL2
      || op === OP.SETJMP || op === OP.LONGJMP;
}

/** `(from, to)` **开区间**里有屏障吗（两头那两条自己不算）。 */
export function barrierBetween(fn, from, to) {
  for (let pc = from + 1; pc < to; pc++) if (isBarrier(fn.op[pc])) return true;
  return false;
}

/** `[def, end]` 这一段里有屏障吗（def 那条自己不算，end 那条算 —— 它可能就是个调用）。
 *  `regalloc` 用这一条挑"值得涂色"的值：只有跨屏障的值才是 POOL 顶不住的那些。 */
export function crossesBarrier(fn, def, end) {
  for (let pc = def + 1; pc <= end; pc++) if (isBarrier(fn.op[pc])) return true;
  return false;
}
