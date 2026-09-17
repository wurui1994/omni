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
import { statModel, statTable, statDot, statJson } from '../../src/core/cli/statgraph.js';

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

/* 6. `--stat` / `--stat-out`（第一百四十七片第二格）：构建统计与依赖图。
 *
 * 两层各判一遍：纯计算那一层（喂一张合成的三模块图，判边数/最长链/dot 的形状），
 * 与端到端那一层（`07_json.omni` **确定**是「2 个模块、1 条边、最长链 2 层」）。 */
{
  const modPath = new Map([[0, '/x/a.omni'], [1, '/x/b.omni'], [2, '/x/c.omni']]);
  const imports = new Map([[0, new Set([1, 2])], [1, new Set([2])], [2, new Set()]]);
  const model = statModel({ modPath, imports, funcs: [{ mod: 1 }, { mod: 1 }, { mod: 2 }] });
  const table = statTable(model);
  if (model.edges === 3 && model.longest.length === 3) ok('statModel：3 条边、最长链 3 层（a -> b -> c）');
  else bad('statModel 的边与最长链', `edges=${model.edges} longest=${model.longest.length}`);
  if (table.includes('2 次  c.omni') && table.includes('2 fn  b.omni')) {
    ok('statTable：入度与函数数都在表上（c 被依赖 2 次、b 留下 2 个函数）');
  } else bad('statTable 的内容', table);
  const dot = statDot(model);
  if (dot.includes('n0 -> n1;') && dot.includes('n1 -> n2;')) ok('statDot：边印成 graphviz');
  else bad('statDot 的边', dot);
  if (statJson(model) === statJson(model)) ok('statJson 两次出来一样（次序按 id）');
  else bad('statJson 要确定', '两次不同');
}
{
  const dot = join(WORK, 'deps.dot');
  rmSync(dot, { force: true });
  const r = omni(['build', join(ROOT, 'tests', 'cases', '07_json.omni'), '-o', join(WORK, 'j'),
    '--cc', 'clang', '--stat', '--stat-out', dot]);
  const s = r.stderr || '';
  const dotOk = existsSync(dot) && readFileSync(dot, 'utf8').includes('->');
  if (s.includes('模块 2 个、依赖边 1 条、最长链 2 层') && dotOk) {
    ok('build --stat --stat-out x.dot：表对得上，dot 里有边');
  } else bad('build --stat', `dot=${dotOk} ${s.split('\n').slice(-6).join('\n    ')}`);
}

/* ---- `--stat` 的另两半（第一百四十七片第五格）：**时间**与**各层的账**。
 *
 * 「构建统计」说的不只是依赖：时间去哪儿了、每层多少格、哪一层最胀，三样一起才叫统计。
 * 各层那张表**两台机器共用一份量法**（`cli/layers.js`）—— 老那几条腿（js -> js、
 * 前端 -> OIR -> C）还没有显式的图，可胀是同一种胀，尺子得是同一把。
 */
{
  const r = omni(['run', join(ROOT, 'tests', 'cases', '01_basics.omni'), '--stat']);
  const s = r.stderr || '';
  const t = /时间去哪儿了\s+(\d+) 步 \/ 合计 (\d+)ms/.exec(s);
  if (r.status === 0 && t !== null && Number(t[1]) >= 3) {
    ok(`run --stat：时间表 ${t[1]} 步 / 合计 ${t[2]}ms（前端 / check / backend / exec 都在）`);
  } else bad('run --stat 要有时间表', s.split('\n').slice(-8).join('\n    '));
  /* 层与层之间那几个比：**目标文本**（含固定序言）与**按源码那一段**要分开报 ——
   * 一份 67 行的程序在 js 腿上「目标文本」是两百多倍，那两百倍里 99% 是 prelude。 */
  const all = /目标文本\s+(\d+) 字符\s+([\d.]+)x/.exec(s);
  const prog = /按源码那一段\s+(\d+) 字符\s+([\d.]+)x/.exec(s);
  if (all !== null && prog !== null && Number(prog[1]) < Number(all[1])
    && Number(prog[2]) < Number(all[2])) {
    ok(`run --stat：各层的账（目标文本 ${all[2]}x、按源码那一段 ${prog[2]}x —— 固定序言另算）`);
  } else bad('run --stat 要把两个比分开报', s.split('\n').slice(-8).join('\n    '));
  if (s.includes('AST') && s.includes('OIR') && s.includes('最胀的一层')) {
    ok('run --stat：源码 -> AST -> OIR -> 目标文本 四层都在，且指出最胀的一层');
  } else bad('run --stat 的层要齐', s.split('\n').slice(-8).join('\n    '));
  /* **按 kind 的分布**：与图那条腿的「按 op 的分布」同一种读法 —— 只报总数看不出胀在哪儿。
   * 次序要确定（数量降序），所以榜首那一格是可判的。 */
  const ka = /AST 按 kind 的分布（(\d+) 种 \/ (\d+) 格/.exec(s);
  const ko = /OIR 按 kind 的分布（(\d+) 种 \/ (\d+) 格/.exec(s);
  if (ka !== null && ko !== null && Number(ka[2]) > 0 && Number(ko[2]) > 0) {
    ok(`run --stat：AST ${ka[1]} 种 / ${ka[2]} 格、OIR ${ko[1]} 种 / ${ko[2]} 格（老那几条腿也按 kind 数得出来了）`);
  } else bad('run --stat 要有按 kind 的分布', s.split('\n').slice(-12).join('\n    '));
}
{
  /* graph 那台机器上是同一张表（层名不同：那儿的中间层就是「图」）—— 统一那件事的判据。 */
  const lua = join(ROOT, 'ext', 'lua', 'examples', 'basics.lua');
  const r = omni(['run', '--engine', 'graph', lua, '--backend', 'c', '--stat']);
  const s = r.stderr || '';
  const g = /各层的账\s+源码 (\d+) 行[\s\S]*?图\s+(\d+) 格[\s\S]*?目标文本\s+(\d+) 字符\s+([\d.]+)x/.exec(s);
  if (r.status === 0 && g !== null && s.includes('图的形状')) {
    ok(`graph 腿 --stat：图那一层 ${g[2]} 格、目标文本 ${g[4]}x（与 omni 腿同一把尺子）`);
  } else bad('graph 腿要有同一张各层的账', s.split('\n').slice(-8).join('\n    '));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
