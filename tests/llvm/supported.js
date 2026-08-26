// LLVM 后端第一阶段能降的那些 case —— **两条轴共用的一张表**。
//
// AOT（tests/llvm）和 JIT（tests/jit）共用同一个发射器，所以支持面必须是同一张表：
// 分别维护两份的话，某条路悄悄多支持一点就没人拦得住。这张表本身是断言 ——
// 不在表里的 case，两条路都必须以「llvm 后端第一阶段」这个理由拒掉。
//
// 加一条支持面就来这里加一行。

import { join } from 'node:path';

export const SUPPORTED = [
  join('tests', 'wat', 'cases', '01-numeric.wat'),
  join('tests', 'wat', 'cases', '02-control.wat'),
  join('tests', 'cases', '02_numeric.omni'),
  join('tests', 'cases', '04_div_zero.omni'),
  join('tests', 'cases', '16_int_of_real.omni'),
];
