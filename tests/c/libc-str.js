#!/usr/bin/env node
/* 自带 libc 的「纯计算那一半」与平台 libc 的逐行对账。
 *
 * 同一份探子（`tests/x64/libc-str-probe.c`）编两遍：`cc` 是尺子，我们那份走
 * `--libc self`，逐行比。量的是 printf 的旗与长度、`snprintf` 的截断语义、
 * `strtol` 一族的边、`mem*`/`str*` 的重叠与边界、`qsort`/`bsearch`、`sscanf` ——
 * 这些都不问内核，所以两条腿上都该**一行不差**。
 *
 * 只在 arm64 macOS 上跑，别的机器上跳过。
 *
 *   node tests/c/libc-str.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const SRC = join(HERE, '..', 'x64', 'libc-str-probe.c');
const SYSROOT = join(ROOT, 'src', 'sysroot', 'arm64-osx');
const WORK = join(ROOT, '.omni-cache', 'work', 'libc-str');
const REF = join(WORK, 'str-ref');
const OBJ = join(WORK, 'str.o');
const BIN = join(WORK, 'str-self');

/* 不同的行数（量出来的）。**只许变小**。 */
const KNOWN_DIFF = 0;

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write(`  skip 这条轴要 arm64 macOS（这台是 ${process.platform}/${process.arch}）\n`
    + '\n0 passed, 0 failed, 1 skipped\n');
  process.exit(0);
}
if (spawnSync('cc', ['--version'], { encoding: 'utf8' }).status !== 0) {
  process.stdout.write('  skip 这台机器上没有 cc（尺子就是它）\n\n0 passed, 0 failed, 1 skipped\n');
  process.exit(0);
}

mkdirSync(WORK, { recursive: true });
for (const f of [REF, OBJ, BIN]) rmSync(f, { force: true });

const cc = spawnSync('cc', ['-w', '-o', REF, SRC], { encoding: 'utf8' });
if (!existsSync(REF)) bad('尺子编得过（cc）', (cc.stderr || '').slice(0, 300));
else ok('尺子编得过（cc）');

const step = (args, timeout) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout, cwd: ROOT });
const o = step(['c', 'obj', SRC, '--arch', 'arm64', '--os', 'osx', '-f', 'elf', '-o', OBJ], 120000);
if (!existsSync(OBJ)) bad('c obj（我们自己那台 C 前端）', (o.stderr || o.stdout || '').slice(0, 300));
else {
  ok('c obj（我们自己那台 C 前端）');
  const l = step(['c', 'link', OBJ, '-o', BIN, '--stdlib', '--libc', 'self', '--sysroot', SYSROOT,
    '-f', 'macho', '--arch', 'arm64', '--os', 'osx'], 180000);
  if (!existsSync(BIN)) bad('c link --libc self', (l.stderr || l.stdout || '').slice(0, 300));
  else {
    ok('c link --libc self');
    spawnSync('chmod', ['+x', BIN]);
    spawnSync('codesign', ['-f', '-s', '-', BIN]);
  }
}

if (existsSync(REF) && existsSync(BIN)) {
  const a = spawnSync(REF, [], { encoding: 'utf8', timeout: 30000 });
  const b = spawnSync(BIN, [], { encoding: 'utf8', timeout: 30000 });
  if (b.signal !== null) bad('自带 libc 那份跑得完', `signal=${b.signal}`);
  else ok('自带 libc 那份跑得完');
  const la = (a.stdout || '').split('\n');
  const lb = (b.stdout || '').split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) diff.push(`  尺子 ${la[i] ?? '(没有)'}\n  我们 ${lb[i] ?? '(没有)'}`);
  }
  if (diff.length <= KNOWN_DIFF) ok(`不同的行 ${diff.length} 条（${la.length - 1} 行里，记着的是 ${KNOWN_DIFF}）`);
  else bad(`不同的行不超过 ${KNOWN_DIFF} 条`, `现在是 ${diff.length} 条`);
  for (const d of diff) process.stdout.write(`${d}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
