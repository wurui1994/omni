/**
 * elim unread autos —— 删掉"写了但从来没人读"的槽位的 STORE。
 *
 * 照 Go 的 `ssacompile/deadstore.go:432 elimUnreadAutos`：
 * 「先扫一遍所有碰 auto 的指令，记下哪些 auto 真被读过、哪些 store 可能删得掉；
 *   然后把没被读过的那些 auto 的 store 全删了。」
 *
 * 为什么在 MIR 上这一格是**精确**的（不必像 Go 那样追地址）
 * ------------------------------------------------------
 * MIR 里**没有任何一条 op 能取一个 SLOT 的地址**（ir.js 的 op 表：角色 's' 只出现在
 * `LOAD` 与 `STORE` 的 aux 上，两条）。所以"这个槽有没有被读"= 有没有一条 `LOAD`
 * 指着它，一次线性扫描就是全部答案 —— Go 那边要追 `OpLocalAddr` 的传播，是因为它的
 * auto 会被取地址。取地址的局部量在我们这儿是另一回事（`FRAME` 那一块，或者线性内存腿
 * 上的影子栈），归 `dead auto elim` 那一格，见文件末尾那段为什么它还没挂上。
 *
 * 删指令走 `deadcode.js` 的 `removeInsns`（MIR 里没有 NOP，删的活集中在一处）。
 * 被 STORE 喂的那些纯计算不用这一格管：没人引用之后紧跟的 deadcode 会收走。
 *
 * 槽位本身**不删也不重编号**：槽号在 `LOAD/STORE` 的 aux 与 `fn.params[].slot` 上，
 * 重编号等于把两处一起改，而一个没人引用的槽在后端那边本来就不占地方
 * （帧布局是按"引用到的槽"算的）。Go 也是这样：auto 留在表里，只是没人再碰它。
 */

import { OP } from '../ir.js';
import { registerPass } from './pass.js';
import { removeInsns } from './deadcode.js';

/**
 * 就地删"没人读的槽"的 STORE。回删了几条。
 */
export function elimUnreadAutos(fn, _mod) {
  if (!fn || fn.slots.length === 0) return 0;
  const n = fn.op.length;

  /* 一、哪些槽被读过 */
  const read = new Set();
  for (let pc = 0; pc < n; pc++) {
    if (fn.op[pc] === OP.LOAD) read.add(fn.aux[pc]);
  }

  /* 二、写进没人读的槽的那些 STORE */
  const doomed = new Set();
  for (let pc = 0; pc < n; pc++) {
    if (fn.op[pc] !== OP.STORE) continue;
    if (!read.has(fn.aux[pc])) doomed.add(pc);
  }
  if (doomed.size === 0) return 0;

  /* STORE 不产值（t = void），所以删它不会留下悬空 ref；真留下了 removeInsns 会炸。 */
  return removeInsns(fn, doomed);
}

registerPass('elim unread autos', elimUnreadAutos);

/* ------------------------------------------------- 为什么 `dead auto elim` 还空着
 * Go 的那一格（`elimDeadAutosGeneric`）管的是**被取过地址**的 auto：追
 * `OpLocalAddr` 的值流，如果那个地址只流到 store，就把 store 全删。
 *
 * 我们这边"取地址的局部量"现在长这样（C 前端，线性内存腿，`int t[4]`）：
 *
 *   %0 GLOAD  g_$sp          %1 SUB %0 k16       %2 GSTORE %1 g_$sp
 *   %4 ADD %1 %3             %6 MSTORE %4 %5     …                %19 GSTORE %0 g_$sp
 *
 * 那一块的基址（`%1`）**当场被写进了 `$sp` 这个全局**（影子栈的序言）。照 Go 的判据
 * 「地址流到了一条内存操作 ⇒ 这个 auto 必须留着」，这一格在这个形状上**一条都删不掉** ——
 * 不是实现没写，是判据在这个形状上答"留着"。硬让它删 = 把影子栈的序言当特例挖掉，
 * 那就是自己发挥了。
 *
 * 它要能起作用，得等这两件事里的一件：
 *   - native 那条腿上局部量走 `FRAME`（ir.js 里 FRAME 那段说的就是这个落点），
 *     那时基址不进任何全局，Go 的判据原样可用；
 *   - 或者 `decompose user` 先把小聚合拆成标量槽（ADR-0039 第 3 节的第二步），
 *     那些槽根本不再需要地址，于是落到上面 `elim unread autos` 这一格。
 * 先做第二件（通道表里 `decompose user` 在前面），这一格等它。
 */
