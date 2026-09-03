#!/usr/bin/env node
// Omni — 把所有测试套件跑一遍，**一条红了也继续往下跑**。
//
// 为什么要有这个文件：`test:all` 原来是十七个 `node tests/xxx/run.js` 用 `&&` 串起来的，
// 于是第一条红的套件之后全部不跑 —— 这件事在两刀里各掩住了一次真实的红
// （js-roundtrip 那次掩了 14 个套件、incr 那次掩了 7 个），而两次都是「看起来全绿」。
// 顺序执行没问题，短路有问题。
//
// 读结果只看最后那张表：`FAIL` 那一列是套件级的，`N passed, M failed` 是套件自己印的。
//
//   node tests/all.js            全部
//   node tests/all.js mir sexpr  只跑名字里含这些词的

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

// 顺序照旧（快的在前、自举在最后）—— 有些套件会用到前面套件落下的缓存目录。
const SUITES = [
  'run.js', 'cli/tree.js', 'oracle/run.js', 'js-roundtrip/run.js', 'oir/run.js', 'js-exec/run.js',
  'cabi/run.js', 'wat/run.js', 'glr/run.js', 'mir/run.js', 'incr/run.js',
  'c/run.js',
  'llvm/run.js', 'sexpr/run.js', 'asy/run.js', 'jnc/run.js', 'jit/run.js',
  'gpu/run.js', 'bootstrap/run.js',
];

const results = [];
for (const s of SUITES) {
  const name = s === 'run.js' ? 'core' : s.slice(0, s.indexOf('/'));
  if (filters.length > 0 && !filters.some((f) => name.includes(f))) continue;
  process.stdout.write(`\n=== ${name} ===\n`);
  const t0 = Date.now();
  const r = spawnSync('node', [join(here, s)], { stdio: 'inherit' });
  results.push({ name, code: r.status === null ? 1 : r.status, ms: Date.now() - t0 });
}

process.stdout.write('\n---- 套件汇总 ----\n');
let bad = 0;
for (const r of results) {
  if (r.code !== 0) bad++;
  const tag = r.code === 0 ? 'ok  ' : 'FAIL';
  process.stdout.write(`  ${tag} ${r.name}  (${(r.ms / 1000).toFixed(1)}s)\n`);
}
process.stdout.write(`\n${results.length - bad}/${results.length} 个套件通过\n`);
process.exit(bad === 0 ? 0 : 1);
