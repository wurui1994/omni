// 跳表的语义（ADR-0017 第三刀）。同一份 MIR 在闭包解释器（装载期算好的 pc 表）与
// LLVM 后端（`switch`）上跑，输出必须逐字节相同。
//
// 挑的每一条都是"两套实现可能各自猜一个答案"的地方：表项重复指向同一层、表里显式
// 指向兜底那一层、下标越界、下标是负数（无符号读法）、下标大到超出 32 位、下标本身是
// i32、表项指向 LOOP（continue）与外层 BLOCK（break）、空表。
//
// 期望值按 wasm 的 `br_table` 规范算出来的，不是从任何一条腿抄回来的。

import {
  unit, printI64, OP, T_I64, T_I32, T_VOID, REF_NONE,
} from '../mirkit.mjs';

export const expected = [
  // 1. 密集派发，下标 0/1/2 各落一处
  '10', '20', '30',
  // 2. 下标 3 的表项**也指向 case0 那一层** —— 多个下标指向同一个目标是合法的
  //    （LLVM 的 switch 只要求 case 的"值"互不相同）
  '10',
  // 3. 下标 4 的表项显式指向兜底那一层；下标 5/6/7 越界，也走兜底 ——
  //    「表里写着兜底」与「越界」在 wasm 里是同一个去处，两条腿都不许把它们分开
  '99', '99', '99', '99',
  // 4. 下标 -1：wasm 的 br_table 下标按**无符号**读，而 i64 的规范形是有符号的，
  //    所以 -1 是"很大的无符号数" -> 兜底。当成有符号下标去查表就会读到表外。
  '91',
  // 5. 下标 2^32：越界走兜底。截到 32 位再查表的实现会在这里印 12（表项 0）
  '92',
  // 6. 下标是 i32 的 2：i32 下标要真的能派发（LLVM 那边 switch 的类型跟着下标走）
  '33',
  // 7. 下标是 i32 的 -1：规范形是符号扩展过的，同样走兜底
  '94',
  // 8. 表项指向 LOOP（= continue）、兜底指向外层 BLOCK（= break）：
  //    n = 0/1/2 时回循环头，n = 3 越界跳出去。出来时计数器是 4。
  '4',
  // 9. 空表：永远走兜底。表里那条 print 一次都不许跑
  '888',
].join('\n') + '\n';

/**
 * 一个「5 项跳表 + 兜底」的派发器，形状照 wasm 的 switch 惯用法：
 * 五层 BLOCK 由外到内是 join / 兜底 / case2 / case1 / case0，`br_table` 落在最里头，
 * 跳出某一层就正好落在那一层的代码上。层数是**相对**的，所以这个形状嵌在任何深度都成立。
 */
function dispatch(mir, f, idxRef, v0, v1, v2, dflt) {
  const k = mir.consts;
  f.emit(OP.BLOCK, T_VOID);   // join
  f.emit(OP.BLOCK, T_VOID);   // 兜底
  f.emit(OP.BLOCK, T_VOID);   // case2
  f.emit(OP.BLOCK, T_VOID);   // case1
  f.emit(OP.BLOCK, T_VOID);   // case0
  // 下标 0/1/2 各一层，下标 3 重复指向 case0，下标 4 显式指向兜底那一层
  f.emit(OP.BRTABLE, T_VOID, idxRef, f.pushLevels([0, 1, 2, 0, 3]), 3);
  f.emit(OP.END, T_VOID);
  printI64(mir, f, k.int(v0));
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 3);
  f.emit(OP.END, T_VOID);
  printI64(mir, f, k.int(v1));
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 2);
  f.emit(OP.END, T_VOID);
  printI64(mir, f, k.int(v2));
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 1);
  f.emit(OP.END, T_VOID);
  printI64(mir, f, k.int(dflt));
  f.emit(OP.END, T_VOID);
}

export function build() {
  const { mir, f, k } = unit();

  // ---- 1..3：下标 0..7 各派发一次（增量在派发之前做，所以 continue 是安全的）
  const iSlot = f.slot('i', T_I64);
  f.emit(OP.STORE, T_VOID, k.int(0), REF_NONE, iSlot);
  f.emit(OP.BLOCK, T_VOID);   // 跳出用
  f.emit(OP.LOOP, T_VOID);
  const i0 = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, iSlot);
  const done = f.emit(OP.GE, T_I64, i0, k.int(8), 0);
  f.emit(OP.BRIF, T_VOID, done, REF_NONE, 1);
  f.emit(OP.STORE, T_VOID, f.emit(OP.ADD, T_I64, i0, k.int(1), 0), REF_NONE, iSlot);
  dispatch(mir, f, i0, 10, 20, 30, 99);
  f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 0);
  f.emit(OP.END, T_VOID);
  f.emit(OP.END, T_VOID);

  // ---- 4..7：几个刻意难看的下标
  dispatch(mir, f, k.int(-1), 11, 21, 31, 91);
  dispatch(mir, f, k.int(4294967296), 12, 22, 32, 92);
  dispatch(mir, f, k.i32(2), 13, 23, 33, 93);
  dispatch(mir, f, k.i32(-1), 14, 24, 34, 94);

  // ---- 8：表项指向 LOOP（continue）、兜底指向外层 BLOCK（break）
  const nSlot = f.slot('n', T_I64);
  f.emit(OP.STORE, T_VOID, k.int(0), REF_NONE, nSlot);
  f.emit(OP.BLOCK, T_VOID);
  f.emit(OP.LOOP, T_VOID);
  const n0 = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, nSlot);
  f.emit(OP.STORE, T_VOID, f.emit(OP.ADD, T_I64, n0, k.int(1), 0), REF_NONE, nSlot);
  // 此处深度 2：层 0 = LOOP，层 1 = 外面那个 BLOCK
  f.emit(OP.BRTABLE, T_VOID, n0, f.pushLevels([0, 0, 0]), 1);
  f.emit(OP.END, T_VOID);
  f.emit(OP.END, T_VOID);
  printI64(mir, f, f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, nSlot));

  // ---- 9：空表，永远走兜底
  f.emit(OP.BLOCK, T_VOID);
  f.emit(OP.BRTABLE, T_VOID, k.int(0), f.pushLevels([]), 0);
  printI64(mir, f, k.int(777));
  f.emit(OP.END, T_VOID);
  printI64(mir, f, k.int(888));

  f.emit(OP.RET, T_VOID, REF_NONE);
  return { mir };
}
