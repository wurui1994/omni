// i32 的语义（ADR-0017 第一刀）。每一条都是"32 位与 64 位会给出不同答案"的地方 ——
// 只有这样的用例才证明 T_I32 真的是 32 位，而不是"存在 i64 里碰巧对了"。
//
// 期望值不是从任何一条腿抄回来的，是按 wasm 规范与补码算出来的，逐条写在注释里。

import {
  unit, printI32, printU32, printBool, OP, T_I32, T_VOID, REF_NONE,
} from '../mirkit.mjs';
import { CVT_SEXT8, CVT_SEXT16 } from '../../../stage0/src/mir/ir.js';

export const expected = [
  '-2147483648',  //  1. 2147483647 + 1 回绕
  '0',            //  2. 65536 * 65536 = 2^32 -> 低 32 位全零
  '-2147483648',  //  3. INT32_MIN / -1 溢出，回绕成它自己（不是陷入）
  '0',            //  4. INT32_MIN % -1
  '2',            //  5. 1 << 33：移位量 & 31 = 1
  '-4',           //  6. -8 >> 1 算术右移
  '2147483644',   //  7. -8 u>> 1：0xFFFFFFF8 逻辑右移 = 0x7FFFFFFC
  '2147483647',   //  8. -1 u/ 2：0xFFFFFFFF / 2
  'false',        //  9. -1 u< 1：无符号下是 4294967295 < 1
  'true',         // 10. -1 < 1：有符号
  '-56',          // 11. (int8)200 = 200 - 256
  '-25536',       // 12. (int16)40000 = 40000 - 65536
  '4294967295',   // 13. 同一个 -1，零扩展读出来
].join('\n') + '\n';

export function build() {
  const { mir, f, k } = unit();
  printI32(mir, f, f.emit(OP.ADD, T_I32, k.i32(2147483647), k.i32(1)));
  printI32(mir, f, f.emit(OP.MUL, T_I32, k.i32(65536), k.i32(65536)));
  printI32(mir, f, f.emit(OP.DIV, T_I32, k.i32(-2147483648), k.i32(-1)));
  printI32(mir, f, f.emit(OP.MOD, T_I32, k.i32(-2147483648), k.i32(-1)));
  printI32(mir, f, f.emit(OP.SHL, T_I32, k.i32(1), k.i32(33)));
  printI32(mir, f, f.emit(OP.SHR, T_I32, k.i32(-8), k.i32(1)));
  printI32(mir, f, f.emit(OP.USHR, T_I32, k.i32(-8), k.i32(1)));
  printI32(mir, f, f.emit(OP.UDIV, T_I32, k.i32(-1), k.i32(2)));
  printBool(mir, f, f.emit(OP.ULT, T_I32, k.i32(-1), k.i32(1)));
  printBool(mir, f, f.emit(OP.LT, T_I32, k.i32(-1), k.i32(1)));
  printI32(mir, f, f.emit(OP.CVT, T_I32, k.i32(200), REF_NONE, CVT_SEXT8));
  printI32(mir, f, f.emit(OP.CVT, T_I32, k.i32(40000), REF_NONE, CVT_SEXT16));
  printU32(mir, f, k.i32(-1));
  f.emit(OP.RET, T_VOID, REF_NONE);
  return { mir };
}
