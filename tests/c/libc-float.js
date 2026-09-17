#!/usr/bin/env node
/* 浮点打印与平台 libc 的逐行对账（第一百四十片第九格）。
 *
 * 同一份探子（`tests/x64/libc-float-probe.c`）编两遍：一遍用 `cc`（尺子），一遍用我们
 * 自己那台 C 前端 + `--libc self`（自带 libc）。然后逐行比，**不同的行数就是那个数**。
 *
 * 为什么要一条独立的轴：这是自带 libc 里唯一还差一位的地方，而「差多少」这句话
 * 只有有个能反复量的数才算话 —— 之前那句「17 行里 7 行不同」是手量的，
 * 换一版实现就没法比。这条轴红不红看的是**这个数有没有变大**。
 *
 * 只在 arm64 macOS 上跑（要本机装载 Mach-O + codesign），别的机器上跳过。
 *
 *   node tests/c/libc-float.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const SRC = join(HERE, '..', 'x64', 'libc-float-probe.c');
const SYSROOT = join(ROOT, 'src', 'sysroot', 'arm64-osx');
const WORK = join(ROOT, '.omni-cache', 'work', 'libc-float');
const REF = join(WORK, 'float-ref');
const OBJ = join(WORK, 'float.o');
const BIN = join(WORK, 'float-self');

/* 现在还差多少行（量出来的）。**只许变小** —— 变大就是回退。
 * 走到 0 是第一百四十片第九格：数字改成从位模式摊出来的精确十进制之后，
 * 155 行与 Apple 的 libc 一行不差（改之前是 41 行不同）。 */
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
if (!existsSync(REF)) bad('尺子编得过（cc）', (cc.stderr || '').slice(0, 200));
else ok('尺子编得过（cc）');

const step = (args, timeout) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout, cwd: ROOT });
step(['c', 'obj', SRC, '--arch', 'arm64', '--os', 'osx', '-f', 'elf', '-o', OBJ], 120000);
if (!existsSync(OBJ)) bad('c obj（我们自己那台 C 前端）', '没出 .o');
else {
  ok('c obj（我们自己那台 C 前端）');
  step(['c', 'link', OBJ, '-o', BIN, '--stdlib', '--libc', 'self', '--sysroot', SYSROOT,
    '-f', 'macho', '--arch', 'arm64', '--os', 'osx'], 180000);
  if (!existsSync(BIN)) bad('c link --libc self', '没出可执行文件');
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
  if (la.length === lb.length) ok(`行数相同（${la.length - 1} 行）`);
  else bad('行数相同', `尺子 ${la.length} 行、我们 ${lb.length} 行`);
  const diff = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) diff.push(`  ${la[i] ?? '(没有)'}\n  ${lb[i] ?? '(没有)'}`);
  }
  if (diff.length <= KNOWN_DIFF) {
    ok(`不同的行 ${diff.length} 条（记着的是 ${KNOWN_DIFF}，只许变小）`);
  } else {
    bad(`不同的行不超过 ${KNOWN_DIFF} 条`, `现在是 ${diff.length} 条：\n${diff.slice(0, 6).join('\n')}`);
  }
  for (const d of diff) process.stdout.write(`       尺子 / 我们\n${d}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
