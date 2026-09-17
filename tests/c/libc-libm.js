#!/usr/bin/env node
/* 自带 libm 与平台 libm 的逐点对账（判据版）。
 *
 * 之前这一格是**手量**的（容器里跑一遍，把「最大相对误差 2.18e-12」抄进账里）——
 * 换一版实现就没法比。这一份把它变成能反复跑的：同一份探子编两遍（`cc` 是尺子、
 * 我们那份走 `--libc self`），把两边的数读回来算相对误差，记住「最大值」这个数。
 *
 * 过零点那种地方相对误差没有意义（`cos(π/2)` 的真值是 6e-17，差一个 ulp 就是 100%），
 * 所以判的是「相对误差与绝对误差**取小的那个**」—— 与 libm 的常规口径一致。
 *
 * 只在 arm64 macOS 上跑，别的机器上跳过。
 *
 *   node tests/c/libc-libm.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const SRC = join(HERE, '..', 'x64', 'libc-libm-probe.c');
const SYSROOT = join(ROOT, 'src', 'sysroot', 'arm64-osx');
const WORK = join(ROOT, '.omni-cache', 'work', 'libc-libm');
const REF = join(WORK, 'libm-ref');
const OBJ = join(WORK, 'libm.o');
const BIN = join(WORK, 'libm-self');

/* 量出来的上界（相对/绝对取小者）。**只许变小**。
 * 走到 1e-14 是两处修：π/2 拆三段（tan 在极点附近从 5.75e-11 降下来）、
 * 以及 `sinCore` 补回跳掉的 13! 与 15! 两项（sin(0.707) 从 2.7e-12 降到 1e-16 一档）。
 * 现在最大的那一格是 `pow(1e300, 0.375)` 的 5.4e-15 —— pow 是 `exp(y·log x)`，
 * 两次调用的误差在 112 个数量级上放大，那是这条路本身的账。 */
const MAX_ERR = 1e-14;

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

if (!existsSync(REF)) {
  const cc = spawnSync('cc', ['-w', '-o', REF, SRC, '-lm'], { encoding: 'utf8' });
  if (!existsSync(REF)) bad('尺子编得过（cc）', (cc.stderr || '').slice(0, 200));
  else ok('尺子编得过（cc）');
}

const step = (args, timeout) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout, cwd: ROOT });
step(['c', 'obj', SRC, '--arch', 'arm64', '--os', 'osx', '-f', 'elf', '-o', OBJ], 120000);
if (!existsSync(OBJ)) bad('c obj（我们自己那台 C 前端）', '没出 .o');
else {
  ok('c obj（我们自己那台 C 前端）');
  step(['c', 'link', OBJ, '-o', BIN, '--stdlib', '--libc', 'self', '--sysroot', SYSROOT,
    '-f', 'macho', '--arch', 'arm64', '--os', 'osx'], 180000);
  if (!existsSync(BIN)) bad('c link --libc self（自带 libm 就在里头）', '没出可执行文件');
  else {
    ok('c link --libc self（自带 libm 就在里头）');
    spawnSync('chmod', ['+x', BIN]);
    spawnSync('codesign', ['-f', '-s', '-', BIN]);
  }
}

if (existsSync(REF) && existsSync(BIN)) {
  const a = spawnSync(REF, [], { encoding: 'utf8', timeout: 30000 });
  const b = spawnSync(BIN, [], { encoding: 'utf8', timeout: 30000 });
  if (b.signal !== null) bad('自带 libm 那份跑得完', `signal=${b.signal}`);
  else ok('自带 libm 那份跑得完');
  const la = (a.stdout || '').trim().split('\n');
  const lb = (b.stdout || '').trim().split('\n');
  if (la.length === lb.length && la.length > 100) ok(`采样点 ${la.length} 个（两边一样多）`);
  else bad('两边一样多的采样点', `尺子 ${la.length} 行、我们 ${lb.length} 行`);
  let worst = 0;
  let worstAt = '';
  let same = 0;
  let loose = 0;
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    const [fn, ix, sa] = la[i].split(' ');
    const [fn2, ix2, sb] = lb[i].split(' ');
    if (fn !== fn2 || ix !== ix2) { bad('两边的行对得上', `${la[i]} / ${lb[i]}`); break; }
    /* `~` 打头的是「大参数的三角函数」：不比值，只要求有限、在值域里
     * （我们没有 Payne-Hanek，明记在 math.c 与 README 上）。 */
    if (fn.startsWith('~')) {
      loose++;
      const v = Number(sb);
      const inRange = Number.isFinite(v)
        && (fn === '~tan' || (v >= -1.0000000001 && v <= 1.0000000001));
      if (!inRange) bad(`${fn}[${ix}] 有限且在值域里`, `我们回的是 ${sb}`);
      continue;
    }
    if (sa === sb) { same++; continue; }
    const va = Number(sa);
    const vb = Number(sb);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) {
      if (String(va) !== String(vb)) bad(`${fn}[${ix}] 两边都是 inf/nan`, `${sa} / ${sb}`);
      continue;
    }
    const abs = Math.abs(va - vb);
    const err = Math.min(abs, va === 0 ? abs : abs / Math.abs(va));
    if (err > worst) { worst = err; worstAt = `${fn}[${ix}] 尺子 ${sa} / 我们 ${sb}`; }
  }
  process.stdout.write(`       逐字节相同的点：${same} / ${la.length}\n`);
  if (worst <= MAX_ERR) ok(`最大误差 ${worst.toExponential(3)}（上界 ${MAX_ERR}）—— ${worstAt || '全同'}`);
  else bad(`最大误差不超过 ${MAX_ERR}`, `现在是 ${worst.toExponential(3)}：${worstAt}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
