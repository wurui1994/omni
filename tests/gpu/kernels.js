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
  { src: join('tests', 'gpu', 'cases', '01-bump.sx'), kernels: ['bump'] },
  { src: join('tests', 'gpu', 'cases', '02-saxpy.sx'), kernels: ['saxpy'] },
];

/**
 * 设备比对（门槛 7 的前半句）。每条是「这份 case 的这个 kernel，在设备上用这些输入跑一遍」。
 *
 * `bufs` 的初值与 `push` 是**宿主要灌进去的东西**，而 case 的前一半输出印的是同一批值 ——
 * 测试轴核对这两者相同，所以这张表不会悄悄和 case 走散。后一半输出就是 CPU 上的答案，
 * 设备算出来的必须与它逐个数值相同。
 *
 * `grid` 与 case 里 `(dispatch ... (int N) ...)` 的 N 相同。设备上实际起的调用数会被
 * 向上取整到工作组大小（模块里的 LocalSize，宿主从模块读），多出来的道靠 kernel 用 blen 守门。
 */
export const DEVICE = [
  {
    src: join('tests', 'gpu', 'cases', '01-bump.sx'),
    kernel: 'bump',
    grid: 4,
    bufs: [{ type: 'i64', cells: ['9223372036854775807', '-3', '0', '41'] }],
    push: ['i64:1'],
  },
  {
    // 这台机器上会 skip：Metal 没有双精度（shaderFloat64 = 0），宿主以退出码 3 退出。
    src: join('tests', 'gpu', 'cases', '02-saxpy.sx'),
    kernel: 'saxpy',
    grid: 6,
    bufs: [
      { type: 'f64', cells: ['1', '2', '3', '4'] },
      { type: 'f64', cells: ['10', '20', '30', '40'] },
      { type: 'f64', cells: ['0', '0', '0', '0'] },
    ],
    push: ['f64:2'],
  },
];

/** 没有 kernel 的模块：GPU 那条腿必须拒，而不是"发一个空模块"。 */
export const NO_KERNEL = [
  join('tests', 'sexpr', 'cases', '01-core.sx'),
  join('tests', 'sexpr', 'cases', '02-strings.sx'),
  join('tests', 'sexpr', 'cases', '03-simd.sx'),
];
