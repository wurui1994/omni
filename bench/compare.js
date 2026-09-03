#!/usr/bin/env node
// 语言对照：同一算法跑在 Omni(js) / Omni(c) / LuaJIT / Python 上，
// 先断言输出一致（这是"对照测试"的本体），再顺手报耗时。
//
//   node bench/compare.js

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'src', 'core', 'cli.js');

const targets = [
  { name: 'omni (js backend)', cmd: process.execPath, args: [CLI, 'run', 'bench/fib.omni'] },
  { name: 'omni (c backend) ', cmd: process.execPath, args: [CLI, 'run-c', 'bench/fib.omni'] },
  { name: 'luajit           ', cmd: 'luajit', args: ['bench/fib.lua'] },
  { name: 'python3          ', cmd: 'python3', args: ['bench/fib.py'] },
];

function have(cmd) {
  if (cmd === process.execPath) return true;
  return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;
}

let reference = null;
let mismatch = false;

for (const t of targets) {
  if (!have(t.cmd)) {
    process.stdout.write(`  skip  ${t.name}  (${t.cmd} not installed)\n`);
    continue;
  }
  const start = process.hrtime.bigint();
  const r = spawnSync(t.cmd, t.args, { encoding: 'utf8', cwd: root });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.status !== 0) {
    process.stdout.write(`  FAIL  ${t.name}  exit ${r.status}\n${r.stderr}\n`);
    mismatch = true;
    continue;
  }
  const out = r.stdout.trim();
  if (reference === null) reference = { name: t.name, out };
  const same = out === reference.out;
  if (!same) mismatch = true;
  process.stdout.write(
    `  ${same ? 'ok  ' : 'DIFF'}  ${t.name}  ${ms.toFixed(0).padStart(6)} ms  ${JSON.stringify(out)}\n`,
  );
}

if (!existsSync(join(root, 'bench', 'fib.omni'))) process.stdout.write('  (bench/fib.omni missing)\n');
if (mismatch) {
  process.stdout.write('\n对照失败：各语言输出不一致或有执行错误\n');
  process.exitCode = 1;
} else {
  process.stdout.write('\n对照通过：所有可用实现输出一致\n');
}
