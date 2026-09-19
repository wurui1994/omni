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
 * 2. `MSTORE`（线性内存，C 的影子栈就在这上头）—— **保守**：只有
 *    「地址是**同一个 ref**、访问描述符（aux）也一样」才算同一处（于是字节区间逐字节相同，
 *    不必像 Go 那样维护 `shadowedRanges` 的区间集），而且中间一条**可能读内存**的指令都不许有。
 *    `MSTORE`/`PSTORE`/`STORE`/`GSTORE` 自己不读，所以它们不打断（Go 的
 *    `deadstore.go:56` 那句注释是同一件事："These ops never read from their memory input"）。
 *
 * 为什么"地址逃逸了"不影响正确性：这一格只在**后面有一条写同一处**的时候删前一条，
 * 那块地方反正会被写上新值 —— 与谁拿着它的地址无关。
 *
 * 删指令走 `edit.js` 的 `removeInsns`（MIR 里没有 NOP）。
 */

import { OP, OP_NAMES } from '../ir.js';
import { buildCfg } from './cfg.js';
import { removeInsns } from './edit.js';
import { registerPass } from './pass.js';

/* **不会读线性内存**的那些 op（白名单，其余一律当"可能读"）。
 * 方向是保守的：新加一条 op 而忘了登记，它会被当成读内存 —— 少删一点，不会错。 */
const NO_READ_NAMES = [
  // 区域标记与跳转（控制流本身不读内存）
  'BLOCK', 'LOOP', 'IF', 'ELSE', 'END', 'BR', 'BRIF', 'BRTABLE', 'RET',
  // 槽位与模块级"一格"的读写：与线性内存是两回事
  'LOAD', 'STORE', 'GLOAD', 'GSTORE',
  // 写内存的那几条（写不算读，见上面第 2 条）
  'MSTORE', 'PSTORE',
  // 纯算术/比较/转换
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'NEG', 'SHL', 'SHR', 'BAND', 'BOR', 'BXOR', 'BNOT', 'NOT',
  'EQ', 'NE', 'LT', 'GE', 'LE', 'GT', 'ULT', 'UGE', 'ULE', 'UGT',
  'UDIV', 'UMOD', 'USHR', 'CVT', 'PEQ', 'PISNULL', 'PTHIN', 'PADD', 'PSUB', 'PNULL',
  // 地址（算地址不访问内存）
  'FRAME', 'GADDR', 'FADDR', 'MSIZE', 'SPGET', 'FPGET',
  // 向量的三条
  'VSPLAT', 'VINS', 'VEXT',
];
const NO_READ = new Set();
for (const n of NO_READ_NAMES) {
  if (OP[n] === undefined) throw new Error(`mir/opt/dse: 没有 op "${n}"`);
  NO_READ.add(OP[n]);
}
/** 这条指令可能读线性内存吗（保守：白名单之外一律算读）。 */
function mayReadMemory(op) { return !NO_READ.has(op); }

/**
 * 跑 dse。回删了几条。
 */
export function dse(fn, _mod) {
  if (!fn || fn.op.length === 0) return 0;
  const cfg = buildCfg(fn);
  if (cfg.blocks.length === 0) return 0;
  const doomed = new Set();

  for (const bb of cfg.blocks) {
    /* **从后往前**走：`killed` = "这处后面已经有一条写了、中间没有读"。 */
    const slotKilled = new Set();
    const memKilled = new Set();
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
      if (op === OP.SETJMP || op === OP.LONGJMP) { slotKilled.clear(); memKilled.clear(); continue; }
      if (op === OP.MSTORE) {
        const key = `${fn.a[pc]}|${fn.aux[pc]}`;
        if (memKilled.has(key)) doomed.add(pc); else memKilled.add(key);
        continue;
      }
      if (mayReadMemory(op)) memKilled.clear();
    }
  }

  /* STORE/MSTORE 都不产值（t = void），所以删它们不会留下悬空 ref；
     真留下了 removeInsns 会当场炸。 */
  return removeInsns(fn, doomed);
}

registerPass('dse', dse);

/** 给判据用：这一格认为"不读内存"的那些 op（名字）。 */
export function noReadOpNames() {
  const out = [];
  for (const o of NO_READ) out.push(OP_NAMES[o]);
  return out;
}
