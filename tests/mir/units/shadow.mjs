// 影子栈的约定（ADR-0017 第三刀）。这一格**没有加任何一条 op** —— 它要证的正是
// 「MIR 现有的东西已经够用」：`&局部量` 不需要「槽位的地址」这种概念，只要
//
//   一个 i64 全局当栈指针（$sp，向下长，和真 ABI 一样）
//   进函数减一个常量、出函数加回去
//   `&x` = `$sp + 常量偏移` —— 一条 ADD，不是一条新指令
//
// 于是 MIR 的槽位仍然是「寄存器」（LLVM 那边 mem2reg 能提），只有**真的被取过地址**的
// 局部量才落到线性内存里。这是 wasm 工具链的标准做法，也是决策四给决策三第 4 格的答案。
//
// 两条腿跑同一份 MIR：解释器里 $sp 是 globals 数组里的一个 BigInt、内存是 DataView；
// LLVM 那边 $sp 是 `@g_sp`、内存是 omni_lin_at 回来的真指针。输出必须逐字节相同。

import { unit, printI64, OP, T_I64, T_VOID, REF_NONE } from '../mirkit.mjs';
import { MirFunc, memDesc, MLOAD_KINDS, MSTORE_KINDS } from '../../../src/core/mir/ir.js';

const LD64 = memDesc(MLOAD_KINDS.indexOf('i64'), 0);
const ST64 = memDesc(MSTORE_KINDS.indexOf('i64'), 0);

export const expected = [
  // 1. 被取过地址的局部量 x 还在（被调者写的是 y 的那 8 个字节，不是 x 的）
  '7',
  // 2. 写穿地址真的发生了：`fill(&y, 42)` 之后 y 是 42。这一条钉住"取地址"这件事 ——
  //    如果 &y 只是一个数字而不是真地址，被调者写的就是别处
  '42',
  // 3. 递归：每一层帧拿到自己的 8 个字节（rec(3) = 3+2+1+0）。共享一块内存但不互相踩，
  //    靠的就是"进函数减、出函数加"这一对
  '6',
  // 4. 出栈之后 $sp 回到初始值 —— 帧的加减是配平的（131072 = 2 页）
  '131072',
].join('\n') + '\n';

export function build() {
  const { mir, f, k } = unit();
  mir.setMem(2, 4);
  const sp = mir.globalNo('sp');
  mir.setGlobalTy(sp, T_I64);
  const SP_TOP = 131072;   // 初始内存的顶端 = 2 页。栈往下长，所以从这里开始

  // ---- fill(addr, v)：`*addr = v`。C 里的 `void fill(long *p, long v) { *p = v; }`
  const fill = new MirFunc('fill', [{ name: 'addr', t: T_I64 }, { name: 'v', t: T_I64 }], T_VOID);
  fill.slot('addr', T_I64);
  fill.slot('v', T_I64);
  {
    const addr = fill.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, 0);
    const v = fill.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, 1);
    fill.emit(OP.MSTORE, T_I64, addr, v, ST64);
    fill.emit(OP.RET, T_VOID, REF_NONE);
  }
  const fillNo = mir.addFunc(fill);

  // ---- rec(n)：每层要 8 个字节存自己的 n，递归回来之后那 8 个字节必须还是自己的
  const rec = new MirFunc('rec', [{ name: 'n', t: T_I64 }], T_I64);
  rec.slot('n', T_I64);
  const rSlot = rec.slot('r', T_I64);
  const recNo = mir.addFunc(rec);
  {
    // 序：$sp -= 8
    const base = rec.emit(OP.SUB, T_I64, rec.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, sp), k.int(8), 0);
    rec.emit(OP.GSTORE, T_VOID, base, REF_NONE, sp);
    const n = rec.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, 0);
    rec.emit(OP.MSTORE, T_I64, base, n, ST64);
    rec.emit(OP.STORE, T_VOID, k.int(0), REF_NONE, rSlot);
    rec.emit(OP.IF, T_VOID, rec.emit(OP.GT, T_I64, n, k.int(0), 0));
    const sub = rec.emit(OP.CALL, T_I64, recNo,
      rec.pushArgs([rec.emit(OP.SUB, T_I64, n, k.int(1), 0)]), 0);
    rec.emit(OP.STORE, T_VOID, sub, REF_NONE, rSlot);
    rec.emit(OP.END, T_VOID);
    // 递归回来之后再读自己那一格：深层的帧在更低的地址上，不许动到这里
    const mine = rec.emit(OP.MLOAD, T_I64, base, REF_NONE, LD64);
    rec.emit(OP.GSTORE, T_VOID, rec.emit(OP.ADD, T_I64, base, k.int(8), 0), REF_NONE, sp);
    rec.emit(OP.RET, T_I64,
      rec.emit(OP.ADD, T_I64, mine, rec.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, rSlot), 0));
  }

  // ---- 入口：$sp = 顶端，然后开一个 16 字节的帧放 x 与 y
  f.emit(OP.GSTORE, T_VOID, k.int(SP_TOP), REF_NONE, sp);
  const base = f.emit(OP.SUB, T_I64, f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, sp), k.int(16), 0);
  f.emit(OP.GSTORE, T_VOID, base, REF_NONE, sp);
  const ax = base;                                              // &x = $sp + 0
  const ay = f.emit(OP.ADD, T_I64, base, k.int(8), 0);           // &y = $sp + 8
  f.emit(OP.MSTORE, T_I64, ax, k.int(7), ST64);
  f.emit(OP.MSTORE, T_I64, ay, k.int(0), ST64);
  f.emit(OP.CALL, T_VOID, fillNo, f.pushArgs([ay, k.int(42)]), 0);
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, ax, REF_NONE, LD64));
  printI64(mir, f, f.emit(OP.MLOAD, T_I64, ay, REF_NONE, LD64));
  printI64(mir, f, f.emit(OP.CALL, T_I64, recNo, f.pushArgs([k.int(3)]), 0));
  // 尾：$sp += 16
  f.emit(OP.GSTORE, T_VOID, f.emit(OP.ADD, T_I64, base, k.int(16), 0), REF_NONE, sp);
  printI64(mir, f, f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, sp));
  f.emit(OP.RET, T_VOID, REF_NONE);
  return { mir };
}
