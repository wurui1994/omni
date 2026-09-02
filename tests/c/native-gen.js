#!/usr/bin/env node
/* `tests/c/gen/` 那一批走 **native 这条腿**（ADR-0017 第九刀第二十六片）。
 *
 * 与 `tests/c/run.js` 的 gen 组同一个 oracle（`tcc -run` 的退出码 + stdout），
 * 差别只在我们这一侧怎么跑：
 *
 *   run.js        .c -> MIR（线性内存）-> 闭包解释器
 *   这一份         .c -> MIR（native）-> 真机器码 -> `.o` -> clang 链 -> **真进程**
 *
 * 为什么要单独一份：native 这条腿上还有一串没做的东西（外部的全局量、初值里的地址、
 * 变长数组、非 ASCII 串常量……）。那些用例在这儿会被我们**明着拒**，而拒掉不算失败 ——
 * 算「还没到」，印出理由。真的失败只有一种：编出来了、跑起来了，可是答案与 tcc 不同。
 *
 * 一条防线：`MIN_OK` —— 能跑通的条数不许比这个数少。少了就是回归（某个用例从「能编」
 * 退回「明着拒」），那种退步不看这一行是发现不了的。
 *
 *   node tests/c/native-gen.js
 *   node tests/c/native-gen.js switch      # 只跑名字里带 switch 的
 */

import { readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'stage0', 'src', 'cli.js');
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/** 能编出来并且跑对的最少条数。往上走是好事（那说明又填了一格），往下走是回归。 */
const MIN_OK = 65;

/**
 * 这几条**问不出同一个答案**，与对错无关：
 *
 * - `37-argv` 数的是 `argv`，而 `tcc -run x.c` 的 argv[0] 是源文件路径、我们的是可执行
 *   文件的路径 —— 两边本来就不同。
 * - `82-flex-init` 印的是**两个全局之间的距离**。C 不保证两个不同对象的相对位置
 *   （6.5.6 第 9 段：只有同一个数组内部的指针相减有意义），我们的 `__data` 摆得比 tcc 松。
 */
const SKIP = new Map([
  ['37-argv', 'argv[0] 两边本来就不同（tcc -run 传的是源文件路径）'],
  ['82-flex-init', '印的是两个全局之间的距离，C 不保证'],
]);

if (!existsSync(TCC)) {
  process.stdout.write('c/native-gen: 没有 tcc（oracle），跳过\n');
  process.exit(0);
}
if (CLANG === undefined) {
  process.stdout.write('c/native-gen: 没找到 clang（链接用），跳过\n');
  process.exit(0);
}
if (process.arch !== 'arm64') {
  process.stdout.write(`c/native-gen: 这台机器是 ${process.arch}，这一片只发 arm64，跳过\n`);
  process.exit(0);
}

const cases = readdirSync(join(here, 'gen')).filter((f) => f.endsWith('.c')).sort()
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));

const dir = mkdtempSync(join(tmpdir(), 'omni-cnative-'));
let ok = 0;
let failed = 0;
const todos = [];
try {
  for (const f of cases) {
    const name = basename(f, '.c');
    const src = join(here, 'gen', f);
    const why = SKIP.get(name);
    if (why !== undefined) {
      process.stdout.write(`  skip ${name}（${why}）\n`);
      continue;
    }
    /* 我们这一侧：`.c` -> `.o`。这一步拒了就是「还没到」，把第一行理由记下来。 */
    const objPath = join(dir, `${name}.o`);
    const obj = spawnSync(process.execPath, [CLI, 'c-obj', src, '-o', objPath],
      { encoding: 'utf8' });
    if (obj.status !== 0) {
      const why = (obj.stderr ?? '').trim().split('\n').find((l) => l.trim() !== '') ?? '?';
      todos.push(`${name}: ${why.slice(0, 120)}`);
      continue;
    }
    const progPath = join(dir, name);
    const link = spawnSync(CLANG, [objPath, '-o', progPath], { encoding: 'utf8' });
    if (link.status !== 0) {
      failed++;
      process.stdout.write(`  FAIL ${name}（链不上）\n${(link.stderr ?? '').trim()}\n`);
      continue;
    }
    const got = spawnSync(progPath, [], { encoding: 'utf8' });
    const want = spawnSync(TCC, ['-B', TCC_DIR, '-run', src], { encoding: 'utf8' });
    if (got.status !== want.status) {
      failed++;
      process.stdout.write(`  FAIL ${name}：退出码 tcc=${want.status} ours=${got.status}\n`);
      continue;
    }
    if ((got.stdout ?? '') !== (want.stdout ?? '')) {
      failed++;
      process.stdout.write(`  FAIL ${name}：stdout 不同\n    tcc  ${JSON.stringify(want.stdout)}\n`
        + `    ours ${JSON.stringify(got.stdout)}\n`);
      continue;
    }
    ok++;
    process.stdout.write(`  ok   ${name}\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n还没到（${todos.length} 条）：\n`);
for (const t of todos) process.stdout.write(`  - ${t}\n`);
process.stdout.write(`\n${ok} passed, ${failed} failed, ${todos.length} not yet\n`);
if (filters.length === 0 && ok < MIN_OK) {
  process.stdout.write(`c/native-gen: 只跑通 ${ok} 条，少于 ${MIN_OK} —— 有回归\n`);
  process.exitCode = 1;
}
if (failed !== 0) process.exitCode = 1;
