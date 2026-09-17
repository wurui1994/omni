#!/usr/bin/env node
/* `build`/`run` 那几格与目标有关的开关（第一百四十六片）：`--cc`、`--libc`、`--sysroot`。
 *
 * 为什么要一条会**真编真跑**的判据：这几格全是「不写会怎样」的默认值 ——
 *   `--libc self` 不给 sysroot：按目标取自带的那一份（`src/sysroot/<arch>-<os>`）
 *   `--arch/--os` 不给 sysroot：同上，于是交叉编译一个开关就够
 *   `--cc`：比 `OMNI_CC` 优先（环境变量管一整轮，命令行管这一趟）
 * 默认值只有跑一趟才看得出来对不对，`--help` 里那行字是**说明**、不是证据。
 *
 * 反面那两格同样要守住：
 *   没有自带 sysroot 的目标（`x86_64-osx`）要**明着骂**，不许悄悄按本机编
 *   `omni c obj|link` 那一层**不推** —— 它对着 cc 的口径。量到过：推了之后
 *   `tests/c/run.js` 当场红（那一套按 `--arch x86_64` 交叉编，靠的是本机 SDK 的头）
 *
 *   node tests/cli/build-flags.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const SRC = join(ROOT, 'tests', 'cases', '01_basics.omni');
const WORK = join(ROOT, '.omni-cache', 'work', 'cli-build-flags');

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };
const omni = (args, env) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout: 600000, cwd: ROOT, env: { ...process.env, ...(env ?? {}) } });

mkdirSync(WORK, { recursive: true });
rmSync(join(WORK, 'a'), { force: true });
rmSync(join(WORK, 'lin'), { force: true });

/* 1. `--libc self` 一个开关：sysroot 按本机取自带的，出来的是纯静态、而且跑得对。 */
{
  const out = join(WORK, 'a');
  const r = omni(['build', SRC, '-o', out, '--libc', 'self']);
  if (!existsSync(out)) bad('build --libc self（不给 sysroot）', (r.stderr || r.stdout || '').slice(0, 400));
  else {
    ok('build --libc self（不给 sysroot）');
    const run = spawnSync(out, [], { encoding: 'utf8', timeout: 60000 });
    const want = omni(['run', SRC, '--interp']);
    if ((run.stdout || '') === (want.stdout || '')) ok('跑出来与解释器逐字相同');
    else bad('跑出来与解释器逐字相同', `ours ${JSON.stringify((run.stdout || '').slice(0, 80))}`);
    if (process.platform === 'darwin') {
      const l = spawnSync('otool', ['-L', out], { encoding: 'utf8' });
      const lines = (l.stdout || '').split('\n').filter((s) => s.includes('.dylib'));
      if (lines.length === 0) ok('otool -L 一条 dylib 都不印（纯静态）');
      else bad('otool -L 一条 dylib 都不印', lines.join('\n'));
    }
  }
}

/* 2. 交叉编译也是一个开关：`--arch/--os` 定目标，sysroot 自动。只看容器头 ——
 *    这台机器上跑不了那份东西（真跑那一格在 `tests/x64/docker-run.sh` 上）。 */
{
  const out = join(WORK, 'lin');
  const r = omni(['build', SRC, '-o', out, '--arch', 'x86_64', '--os', 'linux']);
  if (!existsSync(out)) bad('build --arch x86_64 --os linux（不给 sysroot）', (r.stderr || r.stdout || '').slice(0, 400));
  else {
    const b = readFileSync(out);
    const elf = b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
    const m = b[18] | (b[19] << 8);           /* e_machine：x86_64 是 0x3e */
    if (elf && b[4] === 2 && m === 0x3e) ok('出来的是 ELF64 / x86-64');
    else bad('出来的是 ELF64 / x86-64', `elf=${elf} class=${b[4]} machine=0x${m.toString(16)}`);
  }
}

/* 3. 没有自带 sysroot 的目标：明着骂，而且把有哪几个印出来。 */
{
  const r = omni(['build', SRC, '-o', join(WORK, 'nope'), '--arch', 'x86_64', '--os', 'osx']);
  const msg = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && msg.includes('x86_64-osx') && msg.includes('x86_64-linux')) {
    ok('没有那一份 sysroot 时明着骂（还印出自带的有哪几个）');
  } else bad('没有那一份 sysroot 时明着骂', `rc=${r.status} ${msg.slice(0, 200)}`);
}

/* 4. `--cc` 比 `OMNI_CC` 优先：两个方向各量一次（那行摘要里的 `via …` 就是答案）。 */
{
  const withCC = omni(['build', SRC, '-o', join(WORK, 'cc1'), '--cc', 'self'], { OMNI_CC: 'clang' });
  const s1 = `${withCC.stderr || ''}`;
  if (s1.includes('via self')) ok('--cc self 盖过 OMNI_CC=clang');
  else bad('--cc self 盖过 OMNI_CC=clang', s1.slice(0, 300));
  const hasClang = spawnSync('which', ['clang'], { encoding: 'utf8' }).status === 0;
  if (!hasClang) process.stdout.write('  skip 这台机器上没有 clang（另一个方向量不了）\n');
  else {
    const r = omni(['build', SRC, '-o', join(WORK, 'cc2'), '--cc', 'clang'], { OMNI_CC: 'self' });
    const s2 = `${r.stderr || ''}`;
    if (s2.includes('via clang')) ok('--cc clang 盖过 OMNI_CC=self');
    else bad('--cc clang 盖过 OMNI_CC=self', s2.slice(0, 300));
  }
}

/* 5. `omni c link` 那一层**不推**：`--libc self` 不给 sysroot 照旧是一句响错。 */
{
  const r = omni(['c', 'link', join(WORK, 'nothing.o'), '-o', join(WORK, 'x'),
    '--stdlib', '--libc', 'self', '-f', 'elf', '--arch', 'x86_64', '--os', 'linux']);
  const msg = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && msg.includes('--libc self 要配 --sysroot')) ok('c link 那一层不推 sysroot（还是要写明白）');
  else bad('c link 那一层不推 sysroot', `rc=${r.status} ${msg.slice(0, 200)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
