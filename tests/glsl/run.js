#!/usr/bin/env node
// Omni — GLSL 前端的测试轴（ADR-0019）
//
// 四组，一条红了也继续往下跑（与 tests/all.js 同一个理由：短路会掩住后面的红）：
//
//   parse.js  —— 语法表与五份尺子源码（第一片）
//   check.js  —— 类型检查与名字解析（第二片）
//   lower.js  —— 降到核心方言，JS 腿与 C 腿都跑（第三、六片）
//   render.js —— 把画布按 quad 扫一遍（第四片）
//   bench.js  —— 量性能那一段（第五片；不判快慢，判「量的是同一件事」）
//   interp.js —— 顶点着色器与插值（第七片）
//   raster.js —— 覆盖判定与边上的归属（第八、九片）
//   stmt.js   —— 语句那一层的补全：`do while` 与 `switch`（第十九片）
//   ops.js    —— 运算符补全：位运算、移位、`^^`、六种复合赋值（第二十片）
//   mat.js    —— 非方阵 `matCxR`（第二十一片）
//   fns.js    —— 内建补全：8.1/8.3 剩下几条 + 8.4 几何三条 + 8.5 矩阵五条（第二十三片）
//   fast.js   —— 快路（8 道 f32 -> LLVM IR）与参照实现逐取样点对账（决策六）
//   oracle.js —— 与**真 GL** 比像素（第十片；没有 python3+moderngl 就跳过）
//
//   node tests/glsl/run.js

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PARTS = ['parse.js', 'check.js', 'lower.js', 'render.js', 'bench.js',
  'interp.js', 'raster.js', 'stmt.js', 'ops.js', 'mat.js', 'fns.js', 'pp.js', 'fast.js', 'oracle.js'];

let bad = 0;
for (const p of PARTS) {
  process.stdout.write(`\n--- glsl/${p} ---\n`);
  const r = spawnSync('node', [join(here, p)], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
}
process.stdout.write(`\n${PARTS.length - bad}/${PARTS.length} 组绿\n`);
process.exit(bad === 0 ? 0 : 1);
