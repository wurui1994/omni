/**
 * addressing modes —— 把 `ADD(基址, 常量)` 折进访存指令自己的偏移格里。
 * 照 Go 的 `ssa/addressingmodes.go`（通道表里紧跟 `lower` 的那一格）。
 *
 * 为什么这一格是那个大头（**对着两边的机器码数出来的**）
 * --------------------------------------------------
 * 同一份 smallpt、同一个 `radiance`，反汇编出来：
 *   Go（`go tool objdump`）473 条指令、帧 384 字节
 *   我们              **4602 条**、帧 **20272 字节**
 * 我们这边每存一格长这样：
 *
 *   ldr  x13, [x11, #0x8]
 *   mov  x9, x19          ← 把基址抄一份
 *   add  x9, x9, #0x8     ← 加常量偏移
 *   str  x13, [x9]        ← 才开始存
 *
 * 三条指令干一条 `str x13, [x19, #8]` 的事。而后端**本来就会**把访问描述符里的静态偏移
 * 折进 `ldr`/`str` 的立即数（`arm64/from_mir.js` 的 `mload`/`mstore`：`fold ? off : 0`）——
 * 缺的只是**把那个常量从 `ADD` 搬到描述符里**。这一格就是干这件事。
 *
 * 形状：`MLOAD ADD(p, k)` 的 aux 从 `memDesc(宽度, off)` 变成 `memDesc(宽度, off + k)`，
 * `a` 换成 `p`。那条 `ADD` 随后没人引用，紧跟的 deadcode 收走。一条指令都不增。
 *
 * 常量可以是一棵小树（`MUL(k0,k4)` 那种，见 `memory.js` 的 `constOffset`）——
 * C 前端的数组下标就是那个形状。
 */

import { OP, REF_BIAS, REF_NONE, memDesc, memKindNo, memOff } from '../ir.js';
import { constOffset } from './memory.js';
import { registerPass } from './pass.js';

/**
 * 跑 addressing modes。回折进去了几条。
 */
export function addressingModes(fn, mod) {
  if (!fn || fn.op.length === 0) return 0;
  let n = 0;
  for (let pc = 0; pc < fn.op.length; pc++) {
    const op = fn.op[pc];
    if (op !== OP.MLOAD && op !== OP.MSTORE) continue;
    /* 最多剥三层 `ADD(ADD(p,k1),k2)` —— 有界。 */
    for (let round = 0; round < 3; round++) {
      const addr = fn.a[pc];
      if (addr === REF_NONE || addr < REF_BIAS) break;
      const apc = addr - REF_BIAS;
      if (fn.op[apc] !== OP.ADD) break;
      /* 哪一边是常量（另一边就是基址）。两边都是常量的交给 `opt` 去折。 */
      const ka = constOffset(fn, mod, fn.a[apc]);
      const kb = constOffset(fn, mod, fn.b[apc]);
      let base = REF_NONE, k = 0;
      if (kb !== null && fn.a[apc] >= REF_BIAS && fn.a[apc] !== REF_NONE) { base = fn.a[apc]; k = kb; }
      else if (ka !== null && fn.b[apc] >= REF_BIAS && fn.b[apc] !== REF_NONE) { base = fn.b[apc]; k = ka; }
      else break;
      const off = memOff(fn.aux[pc]) + k;
      /* 负偏移在 `memDesc` 里放不下（它按"静态偏移 * 16 + 宽度号"打包），不折。 */
      if (off < 0) break;
      fn.a[pc] = base;
      fn.aux[pc] = memDesc(memKindNo(fn.aux[pc]), off);
      n++;
    }
  }
  return n;
}

registerPass('addressing modes', addressingModes);
