#!/usr/bin/env node
/* `--profile` 那三档（第一百四十七片）：cc / sample / stub。
 *
 * 判的是**归属对不对**，不是数字多少 —— 时间每趟都不一样，而「谁在榜首」「调用了几次」
 * 是确定的。两层各判一遍：
 *
 *   一、运行时那一层（`tests/x64/prof-probe.c` + `src/runtime/omni_prof.c`）：
 *       一份九成时间在 `hot` 里的程序，两档都该把 `hot` 排在第一、而且份额是 `cold`
 *       的十倍以上。这一格量的是 profiler 自己准不准（踩过两个坑：帧链取不到被打断的
 *       函数、按 PC 并会把一个函数拆成十几行 —— 都记在 omni_prof.c 的注释里）。
 *   二、CLI 那一层（`omni run bench/fib.omni --profile …`）：三档都要真的印出榜来，
 *       而且 `u_fib` 的**调用次数是确定的 635621**（斐波那契那棵树的形状定死了它）——
 *       时间会飘，次数不会，所以判据钉的是次数。
 *
 * 反面两格：`--profile cc` 碰上 `--cc self` 要明着骂（我们那台 C 前端还没有
 * `-finstrument-functions`）；`--profile 瞎写` 要把三档列出来。
 *
 *   node tests/cli/profile.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldedToSvg } from '../../src/core/cli/flame.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const PROBE = join(ROOT, 'tests', 'x64', 'prof-probe.c');
const RT = join(ROOT, 'src', 'runtime', 'omni_prof.c');
const FIB = join(ROOT, 'bench', 'fib.omni');
const WORK = join(ROOT, '.omni-cache', 'work', 'cli-profile');

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };
const omni = (args) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout: 900000, cwd: ROOT });
const cc = (args) => spawnSync('clang', args, { encoding: 'utf8', timeout: 300000, cwd: ROOT });

if (spawnSync('clang', ['--version'], { encoding: 'utf8' }).status !== 0) {
  process.stdout.write('  skip 这台机器上没有 clang（cc 那一档要它）\n\n0 passed, 0 failed, 1 skipped\n');
  process.exit(0);
}
mkdirSync(WORK, { recursive: true });

/* 榜上的数据行：两档的表头不同（一档是「% 帧数 名字」，一档是「自用 含子 次数 名字」），
 * 但**都是「头一个词是数」**，而表头与「折叠栈写到了…」那一行不是。 */
const topRows = (text) => text.split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((c) => c.length >= 2 && /^[\d.]+%?$/.test(c[0]));

/* ---- 一、运行时那一层：cc 档 */
{
  const o = join(WORK, 'probe-cc.o');
  const p = join(WORK, 'prof.o');
  const bin = join(WORK, 'probe-cc');
  rmSync(bin, { force: true });
  cc(['-O0', '-g', '-I', join(ROOT, 'src', 'runtime'), '-finstrument-functions', '-c', '-o', o, PROBE]);
  cc(['-O0', '-g', '-I', join(ROOT, 'src', 'runtime'), '-c', '-o', p, RT]);
  cc(['-o', bin, o, p]);
  if (!existsSync(bin)) bad('探子编得过（cc 档）', 'clang 没出二进制');
  else {
    ok('探子编得过（cc 档）');
    const r = spawnSync(bin, [], { encoding: 'utf8', timeout: 300000 });
    const rows = topRows(r.stderr || '');
    const names = rows.map((c) => c[c.length - 1]);
    if (names[0] === 'hot') ok('cc 档：榜首是 hot');
    else bad('cc 档：榜首是 hot', `拿到的是 ${JSON.stringify(names.slice(0, 3))}`);
    const self = (nm) => {
      const row = rows.find((c) => c[c.length - 1] === nm);
      return row ? Number(row[0]) : 0;
    };
    const ratio = self('cold') > 0 ? self('hot') / self('cold') : 0;
    if (ratio >= 10) ok(`cc 档：hot 的自用时间是 cold 的 ${ratio.toFixed(1)} 倍（要 ≥ 10）`);
    else bad('cc 档：hot / cold ≥ 10', `量到 ${ratio.toFixed(2)}（hot ${self('hot')} / cold ${self('cold')}）`);
  }
}

/* ---- 一、运行时那一层：sample 档（同一份探子，不插桩，自己开采样） */
{
  const o = join(WORK, 'probe-s.o');
  const p = join(WORK, 'prof.o');
  const bin = join(WORK, 'probe-sample');
  const folded = join(WORK, 'sample.folded');
  rmSync(bin, { force: true });
  rmSync(folded, { force: true });
  cc(['-O0', '-g', '-I', join(ROOT, 'src', 'runtime'), '-c', '-o', o, PROBE]);
  cc(['-o', bin, o, p]);
  if (!existsSync(bin)) bad('探子编得过（sample 档）', 'clang 没出二进制');
  else {
    ok('探子编得过（sample 档）');
    const r = spawnSync(bin, ['sample'], {
      encoding: 'utf8', timeout: 300000, env: { ...process.env, OMNI_PROF_OUT: folded },
    });
    const rows = topRows(r.stderr || '');
    const names = rows.map((c) => c[c.length - 1]);
    if (names[0] === 'hot') ok('sample 档：榜首是 hot');
    else bad('sample 档：榜首是 hot', `拿到的是 ${JSON.stringify(names.slice(0, 3))}`);
    const pct = rows.length > 0 ? Number((rows[0][0] || '').replace('%', '')) : 0;
    if (pct >= 80) ok(`sample 档：hot 占 ${pct}%（要 ≥ 80）`);
    else bad('sample 档：hot 占 ≥ 80%', `量到 ${pct}%`);
    /* 折叠栈：一行是「栈 计数」，栈里用分号分层 —— 火焰图与 gprof2dot 都吃这个格式。 */
    if (existsSync(folded)) {
      const lines = readFileSync(folded, 'utf8').split('\n').filter((l) => l !== '');
      const shaped = lines.length > 0 && lines.every((l) => /^\S+ \d+$/.test(l));
      const hasHot = lines.some((l) => l.includes(';hot '));
      if (shaped && hasHot) ok(`折叠栈 ${lines.length} 行，形状对、里头有 hot`);
      else bad('折叠栈的形状', `${lines.length} 行；头一行 ${JSON.stringify(lines[0] ?? '')}`);
    } else bad('折叠栈写出来了', `${folded} 不在`);
  }
}

/* ---- 二、CLI 那一层：三档都要印出榜，`u_fib` 的次数是确定的 635621 */
const FIB_CALLS = '635621';
{
  const r = omni(['run', FIB, '--backend', 'c', '--cc', 'clang', '--profile', 'cc']);
  const s = r.stderr || '';
  if (s.includes('编译器插桩') && s.includes(FIB_CALLS)) ok('run --profile cc：印出榜，u_fib 次数对');
  else bad('run --profile cc', s.split('\n').slice(-6).join('\n    '));
}
{
  const r = omni(['run', FIB, '--backend', 'c', '--profile', 'stub']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (s.includes('prof[core]') && s.includes(FIB_CALLS)) ok('run --profile stub（--cc self 那一路）：印出榜');
  else bad('run --profile stub', s.split('\n').slice(-6).join('\n    '));
}
{
  const folded = join(WORK, 'fib.folded');
  rmSync(folded, { force: true });
  const r = omni(['run', FIB, '--backend', 'c', '--cc', 'clang',
    '--profile', 'sample:997', '--profile-out', folded]);
  const s = r.stderr || '';
  if (s.includes('采样') && existsSync(folded)) ok('run --profile sample:997 --profile-out：榜与折叠栈都有');
  else bad('run --profile sample', s.split('\n').slice(-6).join('\n    '));
}

/* ---- 三、火焰图（`cli/flame.js`）：折叠栈 -> SVG。
 *
 * 这一层是**纯字符串计算**，所以直接喂它一段折叠栈 —— 不必先跑一趟程序。
 * 判两件事：形状（每一格一个 `<g>`、宽度按计数分）与**确定性**（两次出来逐字节相同，
 * 不然「两张图对着看」这件事就不成立）。 */
{
  const folded = 'main;a 3\nmain;b 1\n';
  const svg1 = foldedToSvg(folded, 't');
  const svg2 = foldedToSvg(folded, 't');
  const groups = (svg1.match(/<g>/g) ?? []).length;
  if (svg1.startsWith('<svg') && groups === 4) ok(`折叠栈 -> SVG：4 格（all/main/a/b），${svg1.length} 字节`);
  else bad('折叠栈 -> SVG 的形状', `groups=${groups} 头 40 字 ${JSON.stringify(svg1.slice(0, 40))}`);
  if (svg1 === svg2) ok('同一份折叠栈两次出来逐字节相同');
  else bad('SVG 要确定', '两次不同');
  /* `a` 占 3/4，`b` 占 1/4 —— 宽度就该是 900 与 300（总宽 1200）。 */
  const widths = [...svg1.matchAll(/width="(\d+\.\d)"/g)].map((m) => m[1]);
  if (widths.includes('900.0') && widths.includes('300.0')) ok('宽度按计数分（900 / 300）');
  else bad('宽度按计数分', `量到 ${JSON.stringify(widths)}`);
}
{
  const svg = join(WORK, 'fib.svg');
  rmSync(svg, { force: true });
  rmSync(`${svg}.folded`, { force: true });
  const r = omni(['run', FIB, '--backend', 'c', '--cc', 'clang',
    '--profile', 'sample:997', '--profile-out', svg]);
  const s = r.stderr || '';
  if (existsSync(svg) && existsSync(`${svg}.folded`) && s.includes('火焰图')) {
    ok('run --profile-out x.svg：SVG 与折叠栈都落了盘（折叠栈留着，能喂别的工具）');
  } else bad('run --profile-out x.svg', `svg=${existsSync(svg)} folded=${existsSync(`${svg}.folded`)}`);
}

/* ---- 反面两格 */{
  const r = omni(['run', FIB, '--backend', 'c', '--profile', 'cc']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('-finstrument-functions') && s.includes('--profile sample')) {
    ok('--profile cc 碰上 --cc self：明着骂，还给出另两档');
  } else bad('--profile cc + --cc self 要报错', `rc=${r.status} ${s.slice(0, 200)}`);
}
{
  const r = omni(['run', FIB, '--backend', 'c', '--profile', 'bogus']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('cc | sample[:hz] | stub')) ok('--profile 瞎写：把三档列出来');
  else bad('--profile 瞎写要列出三档', `rc=${r.status} ${s.slice(0, 200)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
