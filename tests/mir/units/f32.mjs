// f32 的语义（ADR-0017 第一刀）。挑的每一条都是"单精度与双精度给出不同答案"的地方。
//
// 期望值按 IEEE-754 binary32 算出来的：0.1f 的真值是 0.100000001490116119384765625，
// 印出来是 double 化之后的十进制。

import { unit, printF32, printBool, OP, T_F32, T_VOID, REF_NONE } from '../mirkit.mjs';

export const expected = [
  // 1. 0.1f + 0.2f。单精度下 0.1f+0.2f = 0.30000001192092896（double 那边是
  //    0.30000000000000004）—— 这一条就是"f32 不是 double"的最短证明。
  '0.30000001192092896',
  // 2. 1f/3f = 0.3333333432674408（double 是 0.3333333333333333）
  '0.3333333432674408',
  // 3. 16777216f + 1f = 16777216：单精度只有 24 位有效位，加 1 掉了
  '16777216',
  // 4. 3.4e38f * 2f 溢出成 inf（double 那边只是 6.8e38）
  'inf',
  // 5. 1e-45f 落在**非规格化**区：最接近的单精度数是 2^-149 = 1.4012984643248171e-45
  '1.4012984643248171e-45',
  // 6. -0f：印出来带符号
  '-0',
  // 7. 0.1f + 0.2f == 0.3f 在单精度下**是** true（double 那边是 false）——
  //    0.3f 的真值也是 0.30000001192092896。
  'true',
].join('\n') + '\n';

/** 单精度字面量：常量池收的是"已经 fround 过的 double 的十进制"。 */
const f32 = (k, v) => k.f32(String(Math.fround(v)));

export function build() {
  const { mir, f, k } = unit();
  printF32(mir, f, f.emit(OP.ADD, T_F32, f32(k, 0.1), f32(k, 0.2)));
  printF32(mir, f, f.emit(OP.DIV, T_F32, f32(k, 1), f32(k, 3)));
  printF32(mir, f, f.emit(OP.ADD, T_F32, f32(k, 16777216), f32(k, 1)));
  printF32(mir, f, f.emit(OP.MUL, T_F32, f32(k, 3.4e38), f32(k, 2)));
  printF32(mir, f, f32(k, 1e-45));
  printF32(mir, f, f.emit(OP.NEG, T_F32, f32(k, 0)));
  const sum = f.emit(OP.ADD, T_F32, f32(k, 0.1), f32(k, 0.2));
  printBool(mir, f, f.emit(OP.EQ, T_F32, sum, f32(k, 0.3)));
  f.emit(OP.RET, T_VOID, REF_NONE);
  return { mir };
}
