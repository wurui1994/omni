// LLVM 后端能降的那些 case —— **两条轴共用的一张表**。
//
// AOT（tests/llvm）和 JIT（tests/jit）共用同一个发射器，所以支持面必须是同一张表：
// 分别维护两份的话，某条路悄悄多支持一点就没人拦得住。这张表本身是断言 ——
// 不在表里的 case，两条路都必须以「llvm 后端目前不支持」这个理由拒掉。
//
// 加一条支持面就来这里加一行。

import { join } from 'node:path';

export const SUPPORTED = [
  join('tests', 'wat', 'cases', '01-numeric.wat'),
  join('tests', 'wat', 'cases', '02-control.wat'),
  join('tests', 'cases', '02_numeric.omni'),
  join('tests', 'cases', '04_div_zero.omni'),
  join('tests', 'cases', '16_int_of_real.omni'),
  // 第二阶段（字符串）：核心 s-expr 方言整套都能降了 —— 它只有四个标量类型 + string，
  // 没有容器也没有 dyn，正好是这一阶段支持面的边界。
  join('tests', 'sexpr', 'cases', '01-core.sx'),
  join('tests', 'sexpr', 'cases', '02-strings.sx'),
];
