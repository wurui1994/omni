// 线性内存的语义（ADR-0017 第二刀）。同一份 MIR 在闭包解释器（DataView，固定小端）
// 与 LLVM 后端（omni_lin_at + 原生 load/store，本机字节序）上跑，输出必须逐字节相同。
//
// 挑的每一条都是"两套实现可能各自猜一个答案"的地方：字节序、窄写宽读、符号扩展与零扩展、
// 静态偏移、data 段的初值、grow 的返回值与新页是否清零。
//
// 期望值按 wasm 规范与 IEEE-754 算出来的，不是从任何一条腿抄回来的。

import {
  unit, printI64, printF32, OP, T_I64, T_F64, T_F32, T_VOID, REF_NONE,
} from '../mirkit.mjs';
import { memDesc, MLOAD_KINDS, MSTORE_KINDS } from '../../../stage0/src/mir/ir.js';

const ld = (kind, off) => memDesc(MLOAD_KINDS.indexOf(kind), off === undefined ? 0 : off);
const st = (kind, off) => memDesc(MSTORE_KINDS.indexOf(kind), off === undefined ? 0 : off);

export const expected = [
  // 1. data 段：第 0 页保留，所以段落在 65536。字节 01 02 03 04，按小端读成 i32
  //    就是 0x04030201 = 67305985。这一条同时钉住"data 段进去了"与"读是小端"。
  '67305985',
  // 2. 同一块字节，逐字节读第 0 个 = 1、第 3 个 = 4（`i8u` + 静态偏移）
  '1',
  '4',
  // 3. 写 i64 = -1，再用 `i8u` 读最低那个字节 = 255（窄读不带符号）
  '255',
  // 4. 同一个字节用 `i8s` 读 = -1（符号扩展），这就是 _s 与 _u 的全部差别
  '-1',
  // 5. 写 i64 = 300，用 `i8` 存法只留低 8 位（300 & 255 = 44），再 `i8u` 读回
  '44',
  // 6. 但 MSTORE 这条指令自己的**结果**是存进去之前的那个值 —— 300，不是 44。
  //    （LLVM 那条腿上如果偷懒回读一次，这一行就会印 44。）
  '300',
  // 7. f32 存进去、读回来：0.1 存成单精度是 0.10000000149011612
  '0.10000000149011612',
  // 8. i32 的最高位：写 0x80000000（= 2147483648），`i32s` 读回是 -2147483648
  '-2147483648',
  // 9. 同一个 4 字节 `i32u` 读回是 2147483648
  '2147483648',
  // 10. msize：声明的是 2 页
  '2',
  // 11. mgrow 1 回**旧**页数 2（wasm 的约定）
  '2',
  // 12. grow 之后 msize = 3
  '3',
  // 13. 新长出来的那一页是清零的（读第 2 页的第一个 i64）
  '0',
  // 14. mgrow 到上界之外：声明的上界是 4 页，现在 3 页，再要 2 页 -> -1（不报错）
  '-1',
].join('\n') + '\n';

export function build() {
  const { mir, f, k } = unit();
  mir.setMem(2, 4);
  mir.addData(65536, [1, 2, 3, 4]);
  const A = 65536;

  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(A), REF_NONE, ld('i32s')));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(A), REF_NONE, ld('i8u')));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(A), REF_NONE, ld('i8u', 3)));

  const B = A + 16;
  f.emit(OP.MSTORE, T_I64, k.int(B), k.int(-1), st('i64'));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(B), REF_NONE, ld('i8u')));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(B), REF_NONE, ld('i8s')));

  const C = A + 32;
  const wrote = f.emit(OP.MSTORE, T_I64, k.int(C), k.int(300), st('i8'));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(C), REF_NONE, ld('i8u')));
  printI64(mir, f, wrote);

  const D = A + 40;
  f.emit(OP.MSTORE, T_F32, k.int(D), k.f32(String(Math.fround(0.1))), st('f32'));
  printF32(mir, f, f.emit(OP.MLOAD, T_F32, k.int(D), REF_NONE, ld('f32')));

  const E = A + 48;
  f.emit(OP.MSTORE, T_I64, k.int(E), k.int(2147483648), st('i32'));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(E), REF_NONE, ld('i32s')));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(E), REF_NONE, ld('i32u')));

  printI64(mir, f, f.emit(OP.MSIZE, T_I64, REF_NONE, REF_NONE, 0));
  printI64(mir, f, f.emit(OP.MGROW, T_I64, k.int(1), REF_NONE, 0));
  printI64(mir, f, f.emit(OP.MSIZE, T_I64, REF_NONE, REF_NONE, 0));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, k.int(131072), REF_NONE, ld('i64')));
  printI64(mir, f, f.emit(OP.MGROW, T_I64, k.int(2), REF_NONE, 0));

  f.emit(OP.RET, T_VOID, REF_NONE);
  return { mir };
}
