#!/usr/bin/env node
/* 自带 libc 的**信号**那一格（第十六格）：同一份探子编两遍，两边都该 12 格全 ok。
 *
 * 这一条与别的 libc 判据有一处不同：`c obj` **要带 `--sysroot`**。平台的
 * `<sys/signal.h>` 把 `sigemptyset`/`sigaddset` 写成宏（Darwin 的 sigset_t 是 32 位），
 * 不带 sysroot 时那三格根本不会调到我们的 libc —— 踩过一次，记在探子头上。
 *
 * 探子自己判自己（`ok` / `FAIL` 一行一格），所以这儿既比行、也看 rc。
 *
 * 只在 arm64 macOS 上跑，别的机器上跳过。
 *
 *   node tests/c/libc-signal.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const SRC = join(HERE, '..', 'x64', 'libc-signal-probe.c');
const SYSROOT = join(ROOT, 'src', 'sysroot', 'arm64-osx');
const WORK = join(ROOT, '.omni-cache', 'work', 'libc-signal');
const REF = join(WORK, 'signal-ref');
const OBJ = join(WORK, 'signal.o');
const BIN = join(WORK, 'signal-self');

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
const o = step(['c', 'obj', SRC, '--arch', 'arm64', '--os', 'osx',
  '--sysroot', SYSROOT, '-f', 'elf', '-o', OBJ], 120000);
if (!existsSync(OBJ)) bad('c obj（带 --sysroot，理由见文件头）', (o.stderr || o.stdout || '').slice(0, 300));
else {
  ok('c obj（带 --sysroot，理由见文件头）');
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
  const nBad = (s) => (s.match(/^FAIL /gm) ?? []).length;
  const nOk = (s) => (s.match(/^ok   /gm) ?? []).length;
  if (nBad(a.stdout || '') === 0) ok(`尺子自己全过（${nOk(a.stdout || '')} 格）`);
  else bad('尺子自己全过', `${nBad(a.stdout || '')} 格没过 —— 判据自己的问题，不是 libc 的`);
  if (nBad(b.stdout || '') === 0) ok(`自带 libc 全过（${nOk(b.stdout || '')} 格）`);
  else bad('自带 libc 全过', (b.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).join('\n    '));
  const la = (a.stdout || '').split('\n');
  const lb = (b.stdout || '').split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) diff.push(`  尺子 ${la[i] ?? '(没有)'}\n  我们 ${lb[i] ?? '(没有)'}`);
  }
  if (diff.length === 0) ok(`与尺子逐行相同（${la.length - 1} 行）`);
  else bad('与尺子逐行相同', `不同的行 ${diff.length} 条\n${diff.join('\n')}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
