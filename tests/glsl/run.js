#!/usr/bin/env node
// Omni — GLSL 前端的测试轴（ADR-0019）
//
// 四组，一条红了也继续往下跑（与 tests/all.js 同一个理由：短路会掩住后面的红）：
//
//   parse.js  —— 语法表与五份尺子源码（第一片）
//   check.js  —— 类型检查与名字解析（第二片）
//   lower.js  —— 降到核心方言，JS 腿与 C 腿都跑（第三片）
//   render.js —— 把画布按 quad 扫一遍（第四片）
//
//   node tests/glsl/run.js

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PARTS = ['parse.js', 'check.js', 'lower.js', 'render.js'];

let bad = 0;
for (const p of PARTS) {
  process.stdout.write(`\n--- glsl/${p} ---\n`);
  const r = spawnSync('node', [join(here, p)], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
}
process.stdout.write(`\n${PARTS.length - bad}/${PARTS.length} 组绿\n`);
process.exit(bad === 0 ? 0 : 1);
