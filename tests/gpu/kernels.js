// SPIR-V 那条腿现在能发的 kernel —— **一张显式清单**，和 tests/llvm/supported.js 同一条规矩。
//
// 每行是「哪份源文件的哪几个 kernel」。它本身是断言：支持面扩大时必须来改这张表，
// 而不是让它悄悄漂移。清单之外的 .sx（没有 kernel、或 kernel 里有这一阶段不支持的东西）
// 都必须被 `spirv 后端目前不支持` 拒掉，见 run.js 的第 2 节。

import { join } from 'node:path';

export const KERNELS = [
  {
    src: join('tests', 'sexpr', 'cases', '04-buffers.sx'),
    // MIR 里的名字是 mangle 过的（`k_saxpy`），`--kernel` 两种写法都认
    kernels: ['saxpy', 'bump'],
  },
];

/** 没有 kernel 的模块：GPU 那条腿必须拒，而不是"发一个空模块"。 */
export const NO_KERNEL = [
  join('tests', 'sexpr', 'cases', '01-core.sx'),
  join('tests', 'sexpr', 'cases', '02-strings.sx'),
  join('tests', 'sexpr', 'cases', '03-simd.sx'),
];
