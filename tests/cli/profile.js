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
 * 反面一格：`--profile 瞎写` 要把三档列出来。**「`cc` 要外部编译器」那两句判据作废了**
 * （第一百五十片第三格）：我们自己那台 C 前端复刻了 `-finstrument-functions`，
 * 于是 `--cc self` 下三档都该真的量得到 —— 那几格现在判的是「出榜」，不是「报错」。
 *
 *   node tests/cli/profile.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldedToSvg } from '../../src/core/cli/flame.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const PROBE = join(ROOT, 'tests', 'x64', 'prof-probe.c');
const RT = join(ROOT, 'src', 'runtime', 'omni_prof.c');
const FIB = join(ROOT, 'bench', 'fib.omni');
/** `--direct` 那条腿的样本：它只认 `.js`（同一个算法的手写 JS 那一份）。 */
const FIBJS = join(ROOT, 'bench', 'fib.js');
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

/* ---- 反面一格 + 「self 也做得到」那一格 */{
  /* 从前这一格判的是「`--profile cc` 碰上 `--cc self` 要明着骂」。**翻过来了**
   * （第一百五十片第三格）：我们自己那台 C 前端现在有 `-finstrument-functions` 的等价物，
   * 于是这一趟该**真的量得到** —— 判据钉的是次数（`u_fib` 635621，那棵树的形状定死了它）
   * 与调用栈，不是时间。 */
  const r = omni(['run', FIB, '--backend', 'c', '--profile', 'cc']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && /635621\s+u_fib/.test(s) && /omni_main > u_fib/.test(s)) {
    ok('--profile cc + --cc self：我们自己那台前端插的桩（u_fib 635621 次 + 精确调用栈）');
  } else bad('--profile cc + --cc self 该量得到', `rc=${r.status} ${s.slice(-400)}`);
}
{
  const r = omni(['run', FIB, '--backend', 'c', '--profile', 'bogus']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('cc | sample[:hz] | stub')) ok('--profile 瞎写：把三档列出来');
  else bad('--profile 瞎写要列出三档', `rc=${r.status} ${s.slice(0, 200)}`);
}

/* ---- 三、认腿那一层（第一百四十七片第四格）：**后端不只有 C 一条**。
 *
 * 三档各只在有那台机制的腿上成立，不成立就**当场报** —— 收下开关然后印一张空表是最坏的
 * 一种（用户会以为量过了）。这几格判的就是那张表：
 *   stub   js 腿上**真的能量**（我们自己插的那一对，两个后端发的都是我们的代码）
 *   cc     js 腿上没有（它是外部 C 编译器的 -finstrument-functions）
 *   sample js 腿上还没接（要 node 自己那台 V8 采样器）—— 有名有姓地欠着
 */
{
  const r = omni(['run', FIB, '--profile', 'stub']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /([0-9]+) calls\s+u_fib/.exec(s);
  if (r.status === 0 && s.includes('js 腿 · 发射期插桩') && m !== null && m[1] === '635621') {
    ok(`js 腿 --profile stub：u_fib 调了 ${m[1]} 次（次数是确定的）`);
  } else bad('js 腿 --profile stub 要印出榜来', `rc=${r.status} ${s.slice(-300)}`);
}
{
  const out = join(WORK, 'js.svg');
  const folded = `${out}.folded`;
  rmSync(folded, { force: true });
  rmSync(out, { force: true });
  const r = omni(['run', FIB, '--profile', 'stub', '--profile-out', out]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && existsSync(folded) && existsSync(out)
    && readFileSync(folded, 'utf8').includes('u_fib')) {
    ok('js 腿 --profile-out x.svg：折叠栈 + 火焰图两份都落了');
  } else bad('js 腿 --profile-out', `rc=${r.status} ${s.slice(-300)}`);
}
{
  const r = omni(['run', FIB, '--profile', 'cc']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('外部 C 编译器') && s.includes('--backend c')) {
    ok('js 腿 --profile cc：明着说这条腿上没有那台机器');
  } else bad('js 腿 --profile cc 要报错', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  /* js 腿的 `sample` 从前是有名有姓地欠着的（要 node 自己那台采样器）——
   * 第一百四十八片第三格接上了：量的是**我们发出来那份 JS**，所以榜上有 `u_fib`
   * 那种我们发的名字，也有 `$js_*` 那些运行时助手（正是"胀在哪儿"的答案）。 */
  const r = omni(['run', FIB, '--profile', 'sample:200']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && s.includes('node 的 V8 采样器') && /u_fib|u_sumTo|\$js_/.test(s)) {
    ok('js 腿 --profile sample：借 node 的 V8 采样器，量的是我们发的那份 JS');
  } else bad('js 腿 sample 要出榜', `rc=${r.status} ${s.slice(-300)}`);
}
{
  /* `--direct`：一份 js 原样交给 node（不过我们这一轮）。判据是**输出对** +
   * `-v` 里那一行说清它没走我们那一轮。 */
  const r = omni(['run', '-v', FIBJS, '--direct']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && s.includes('196418') && s.includes('没过我们这一轮')
    && !s.includes('backend js')) {
    ok('--direct：原样交给 node，我们那一轮一个字节都没发生');
  } else bad('--direct 该直接给 node', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  const out = join(WORK, 'node.svg');
  const folded = `${out}.folded`;
  rmSync(folded, { force: true });
  rmSync(out, { force: true });
  const r = omni(['run', FIBJS, '--direct', '--profile', 'sample:200', '--profile-out', out]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const f = existsSync(folded) ? readFileSync(folded, 'utf8') : '';
  if (r.status === 0 && existsSync(out) && /(^|;)(sumTo|fib)\b/m.test(f)) {
    ok('--direct + sample：node 采样器的折叠栈里有源码里的名字（sumTo / fib），火焰图也落了');
  } else bad('--direct sample 要出折叠栈', `rc=${r.status} ${s.slice(-300)}\n    folded=${f.slice(0, 200)}`);
}
{
  const r = omni(['run', FIBJS, '--direct', '--profile', 'stub']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('我们不改你的 js')) {
    ok('--direct + stub：明说发射期插桩对原样交出去的 js 不成立');
  } else bad('--direct stub 要报错', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  /* **`--engine` 只剩一台**（ADR-0044：节点图那一层拆掉了）：给别的名字要当场报。 */
  const lua = join(ROOT, 'ext', 'lua', 'examples', 'basics.lua');
  const r = omni(['run', '--engine', 'graph', lua]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('没有 --engine graph 这一条')) {
    ok('--engine 只剩 omni 一台：别的名字当场报');
  } else bad('--engine graph 该当场报', `rc=${r.status} ${s.slice(0, 300)}`);
}
/* ---- 三、`.c` **输入**那条腿（`c-src`，第一百四十七片第六格）
 *
 * 从前 `run x.c` 把 `--cc` 与 `--profile` 两个开关**悄悄忽略**：那条腿一路走我们自己的
 * C 前端 + 链接器，谁都没问过。量到的原话是
 * `omni run -v BBP_Formula.c --profile sample --cc clang` 印「c front end + codegen」、
 * 一份 profile 都没出。底下五格钉住修好之后的五种结果。 */
{
  /* 这一格用**自带的**一份小 C（`prof-probe.c` 自己会叫 `omni_prof_sample_start`，
   * 不带收集器编不过 —— 那是它作为"运行时那一层的探子"该有的样子）。 */
  const hello = join(WORK, 'hello.c');
  writeFileSync(hello, '#include <stdio.h>\nint main(void) { printf("hi\\n"); return 0; }\n');
  const r = omni(['run', '-v', hello, '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && /omni: clang .*hello\.c ->/.test(s)
    && !s.includes('c front end + codegen') && s.includes('hi')) {
    ok('.c 输入 + --cc clang：整趟交给那台 cc（不再是我们自己那台）');
  } else bad('.c 输入要认 --cc', `rc=${r.status} ${s.slice(0, 400)}`);
}
{
  const r = omni(['run', PROBE, '--profile', 'cc', '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const rows = topRows(s);
  const hot = rows.find((c) => c[c.length - 1] === 'hot');
  const cold = rows.find((c) => c[c.length - 1] === 'cold');
  if (r.status === 0 && rows.length > 0 && rows[0][rows[0].length - 1] === 'hot'
    && hot !== undefined && cold !== undefined
    && Number(hot[0]) >= Number(cold[0]) * 10) {
    ok(`.c 输入 --profile cc：榜首是 hot，是 cold 的 ${(Number(hot[0]) / Number(cold[0])).toFixed(1)} 倍`);
  } else bad('.c 输入 --profile cc 要出榜', `rc=${r.status} ${s.slice(0, 400)}`);
}
{
  const out = join(WORK, 'csrc.svg');
  const folded = `${out}.folded`;
  rmSync(folded, { force: true });
  rmSync(out, { force: true });
  const r = omni(['run', PROBE, '--profile', 'sample:997', '--cc', 'clang',
    '--profile-out', out]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && existsSync(folded) && existsSync(out)
    && readFileSync(folded, 'utf8').includes('hot')) {
    ok('.c 输入 --profile sample：折叠栈里有 hot，火焰图也落了盘');
  } else bad('.c 输入 --profile sample', `rc=${r.status} ${s.slice(0, 400)}`);
}
{
  /* `.c` 输入 + `stub`：这条腿上 `stub` 与 `cc` 是**同一件事**（第一百五十片第三格）——
   * 那份 C 不经我们的发射器，所以"发射期插的那一对"在这儿只能理解成"插桩"，谁编的谁插。
   * 从前这一格判的是「要报错」，现在判的是**真的出榜**、而且次数是确定的 2000。 */
  const r = omni(['run', PROBE, '--profile', 'stub', '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && /2000\s+hot/.test(s) && /main > hot/.test(s)) {
    ok('.c 输入 --profile stub：与 cc 同一台机器（hot 2000 次 + 路径 main > hot）');
  } else bad('.c 输入 --profile stub 要出榜', `rc=${r.status} ${s.slice(-400)}`);
}
{
  /* **`sample` 不再要外部 cc**（第一百五十片第二格）：这一格从"必须报错"翻成"必须量得到"
   * —— 我们自己那台前端 + 链接器全做得到（编收集器 + 换名 main + 自己发一格 main）。
   * 判据跟着翻：`.c` 输入不给 `--cc` 时**照样出榜**，榜首还是 hot。 */
  const r = omni(['run', PROBE, '--profile', 'sample:997']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const rows = topRows(s);
  const first = rows.length > 0 ? rows[0][rows[0].length - 1] : '';
  if (r.status === 0 && first === 'hot' && s.includes('热路径')) {
    ok('.c 输入 sample 不给 --cc：我们自己那台就量得到（榜首 hot），零外部依赖');
  } else bad('.c 输入 sample 该自己量得到', `rc=${r.status} 榜首=${first}\n    ${s.slice(-300)}`);
}
{
  /* **`cc` 那一档也不再要外部编译器**（第一百五十片第三格）：我们自己那台 C 前端复刻了
   * `-finstrument-functions`（`emitProfCall`）。判据钉的是**次数**（`hot` 恰好 2000 次，
   * 那个循环写死的）与路径 —— 时间会飘，这两样不会。 */
  const r = omni(['run', PROBE, '--profile', 'cc']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && /2000\s+hot/.test(s) && /main > hot/.test(s)) {
    ok('.c 输入 --profile cc 不给 --cc：我们自己那台前端插的桩（hot 2000 次 + main > hot）');
  } else bad('.c 输入 cc 该自己插桩', `rc=${r.status} ${s.slice(-400)}`);
}
/* ---- 四、**五张读法**（第一百四十九片）：函数表之外，还要看得见热路径
 *
 * 用户那句话的原文：「只是显示函数调用次数和时间是不够。需要同时显示热路径。」
 * 聚合回溯（一条栈 + 一个权重）本来就是为这个准备的，火焰图只是它的一种画法。 */
{
  const r = omni(['run', PROBE, '--profile', 'sample:997', '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const has = (x) => s.includes(x);
  if (r.status === 0 && has('合计') && has('函数表') && has('热路径')
    && has('最热的调用边') && has('调用树')) {
    ok('C 腿 sample：摘要 / 函数表 / 热路径 / 调用边 / 调用树 五张都印了');
  } else bad('五张读法该都在', `rc=${r.status} ${s.slice(-400)}`);
}
{
  const r = omni(['run', PROBE, '--profile', 'sample:997', '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  /* 热路径那一段里，榜首那条必须落在 `hot` 上 —— 这份探子九成时间在那儿。 */
  const seg = s.slice(s.indexOf('热路径'));
  const first = seg.split('\n').filter((l) => /^\s+[\d.]+\s/.test(l))[0] ?? '';
  if (first.includes('hot') && first.includes('>')) {
    ok(`热路径榜首是整条栈、落在 hot 上：${first.trim().slice(0, 60)}`);
  } else bad('热路径榜首该是 hot 那条', `第一行=${first}`);
}
{
  /* **单位不许混**：C 腿落的是采样帧数，node 腿落的是微秒。量到过 143 帧被印成
   * `0.143 ms`（997Hz 上其实是 ~143ms）—— 差三个数量级的假话。 */
  const c = omni(['run', PROBE, '--profile', 'sample:997', '--cc', 'clang']);
  const cs = `${c.stdout || ''}${c.stderr || ''}`;
  const n = omni(['run', FIBJS, '--direct', '--profile', 'sample:200']);
  const ns = `${n.stdout || ''}${n.stderr || ''}`;
  if (cs.includes('帧数') && cs.includes('帧 /') && ns.includes('ms') && !ns.includes('帧数')) {
    ok('单位跟着腿走：C 腿印「帧数」、node 腿印「ms」');
  } else bad('单位该分开', `C=${cs.includes('帧数')} node=${ns.includes('帧数')}`);
}
{
  /* 递归上**同一条边只算一次**：不去重的话 `u_fib > u_fib` 能量出 90%+ 甚至超过 100%
   * —— 比它所在的整条栈还大。这一格钉住「每条边都 ≤ 100%」。 */
  const r = omni(['run', FIB, '--profile', 'stub']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const seg = s.slice(s.indexOf('最热的调用边'));
  const pcts = [...seg.matchAll(/(\d+\.\d+)%/g)].map((m) => Number(m[1]));
  const over = pcts.filter((p) => p > 100);
  if (seg.includes('u_fib > u_fib') && pcts.length > 0 && over.length === 0) {
    ok(`调用边：递归那条边 ≤ 100%（${pcts.length} 条边，最大 ${Math.max(...pcts)}%）`);
  } else bad('递归边不许超过 100%', `超了 ${over.join(' / ')}`);
}
{
  /* 给了 `--profile-out` 那一趟的产出是**那份折叠栈**，五张不印（要看表就别给它）。 */
  const out = join(WORK, 'views.folded');
  rmSync(out, { force: true });
  const r = omni(['run', FIB, '--profile', 'stub', '--profile-out', out]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && existsSync(out) && !s.includes('热路径') && !s.includes('调用树')) {
    ok('--profile-out 那一趟不印五张（产出是那份折叠栈）');
  } else bad('--profile-out 时该只落文件', `rc=${r.status} ${s.slice(-200)}`);
}

/* `omni flame FILE.folded`：**产物自己**写下来的折叠栈（`OMNI_PROF=sample` 那一路，
 * 比如自举出来的 `dist/omni`）回来之后要有一格门能渲。 */
{
  const folded = join(WORK, 'hand.folded');
  const svg = join(WORK, 'hand.svg');
  rmSync(svg, { force: true });
  writeFileSync(folded, 'main;hot 90\nmain;cold 10\n');
  const r = omni(['flame', folded, '-o', svg]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && existsSync(svg) && readFileSync(svg, 'utf8').includes('hot')) {
    ok('omni flame：折叠栈渲成火焰图（100 帧 / 2 条栈）');
  } else bad('omni flame 要渲出 svg', `rc=${r.status} ${s.slice(0, 300)}`);
}

/* `omni flame` 的另外两种读法（第一百四十九片）：那五张表、以及**两份对照**。
 * 对照那一格是优化循环里最有用的一张：绝对差答"省了多少"、占比差（百分点）答
 * "这一刀有没有把它从热路径上挪走" —— 两趟总时间不同时只看一栏必得错结论。 */
{
  const f = join(WORK, 'views.folded2');
  writeFileSync(f, 'main;hot 900\nmain;cold 100\n');
  const r = omni(['flame', f, '--table']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && s.includes('热路径') && s.includes('帧数') && s.includes('main > hot')) {
    ok('flame --table：产物自己落的折叠栈也看得见热路径（按帧数）');
  } else bad('flame --table 该印五张', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  const a = join(WORK, 'diff-a.folded');
  const b = join(WORK, 'diff-b.folded');
  writeFileSync(a, 'main;hot 900\nmain;cold 100\n');
  writeFileSync(b, 'main;hot 300\nmain;cold 120\nmain;new 80\n');
  const r = omni(['flame', b, '--diff', a]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  /* hot：900 -> 300（-600，占比 90% -> 60% = -30pp）；new 是新出现的那格（0 -> 16%）。 */
  if (r.status === 0 && s.includes('-600') && s.includes('-30.00pp')
    && s.includes('+16.00pp') && s.includes('1000 -> 500')) {
    ok('flame --diff：Δ自用 -600、Δ占比 -30pp、新出现的那格也在表里');
  } else bad('flame --diff 该给出两栏差', `rc=${r.status} ${s.slice(0, 400)}`);
}

{
  /* `flame` 直接收 `.cpuprofile`（node 采样器的原生格式）：单位自动按微秒 ——
   * 「量一趟编译器自己」于是是一条命令（`npm run prof:self -- emit c src/cli.js`）。 */
  const p = join(WORK, 'mini.cpuprofile');
  writeFileSync(p, JSON.stringify({
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' }, children: [2] },
      { id: 2, callFrame: { functionName: 'outer' }, children: [3] },
      { id: 3, callFrame: { functionName: 'inner' }, children: [] },
    ],
    samples: [3, 3, 2],
    timeDeltas: [1000, 2000, 500],
  }));
  const r = omni(['flame', p, '--table']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  /* inner 自用 3000µs = 3ms、占比 3/3.5 = 85.71%；路径是 (root) > outer > inner。 */
  if (r.status === 0 && s.includes('3.000') && s.includes('85.71%')
    && s.includes('(root) > outer > inner') && !s.includes('帧数')) {
    ok('flame 直接收 .cpuprofile：按微秒读，热路径也对');
  } else bad('flame 该认 .cpuprofile', `rc=${r.status} ${s.slice(0, 400)}`);
}

{
  /* `.heapprofile`（`node --heap-prof`）：**分配**那份账，单位是字节（印 KB）。
   * 为什么要它：CPU 那份上 `(garbage collector)` 常年第一名，而 GC 只是结果 ——
   * 「谁在分配」只有这份答得出。形状与 CPU 那份是同一棵树，所以五张表一个字不改。 */
  const p = join(WORK, 'mini.heapprofile');
  writeFileSync(p, JSON.stringify({
    head: {
      callFrame: { functionName: '(root)' },
      selfSize: 0,
      children: [{
        callFrame: { functionName: 'alloc' },
        selfSize: 2048,
        children: [{ callFrame: { functionName: '', url: 'file:///x/y/mod.js', lineNumber: 41 }, selfSize: 1024, children: [] }],
      }],
    },
    samples: [],
  }));
  const r = omni(['flame', p, '--table']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  /* alloc 自用 2048B = 2.0KB / 66.67%；匿名那格带上了文件与行（mod.js:42）。 */
  if (r.status === 0 && s.includes('KB') && s.includes('2.0') && s.includes('66.67%')
    && s.includes('(匿名 mod.js:42)')) {
    ok('flame 收 .heapprofile：按字节读（印 KB），匿名帧带上文件:行');
  } else bad('flame 该认 .heapprofile', `rc=${r.status} ${s.slice(0, 400)}`);
}

{
  /* **基线那一份也要按后缀转**：量到过漏这一步的后果 —— `--diff 基线.heapprofile`
   * 把基线当折叠栈读，一行都解析不出来，表上印「合计 0.0 -> …」，看着像"这一刀把所有
   * 分配都新造出来了"。假话比没有更坏，所以这一格钉住「基线的合计不是 0」。 */
  const a = join(WORK, 'base.heapprofile');
  const b = join(WORK, 'new.heapprofile');
  const mk = (w) => JSON.stringify({
    head: {
      callFrame: { functionName: '(root)' },
      selfSize: 0,
      children: [{ callFrame: { functionName: 'alloc' }, selfSize: w, children: [] }],
    },
    samples: [],
  });
  writeFileSync(a, mk(4096));
  writeFileSync(b, mk(1024));
  const r = omni(['flame', b, '--diff', a]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  /* 4.0KB -> 1.0KB：合计那一行两头都要有数，Δ自用 -3.0。 */
  if (r.status === 0 && s.includes('4.0 -> 1.0') && s.includes('-3.0')) {
    ok('flame --diff：基线也按后缀转（4.0KB -> 1.0KB，不是 0 -> …）');
  } else bad('基线该按后缀转', `rc=${r.status} ${s.slice(0, 300)}`);
}

{
  /* **一帧都没采到也要说话**：量到的原话是 `run 14_json_native.omni --profile sample:997
   * --backend c` 只剩一句「折叠栈写到了 …」，五张表一张都没有 —— 看着像 `--backend c`
   * 被忽略了。真相是那份程序几毫秒就跑完，一帧都没落。沉默让人怀疑开关没生效。 */
  const tiny = join(ROOT, 'tests', 'cases', '14_json_native.omni');
  const r = omni(['run', tiny, '--profile', 'sample:997', '--cc', 'clang', '--backend', 'c']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && s.includes('一帧都没采到') && s.includes('--profile stub')) {
    ok('sample 一帧都没采到：明说为什么 + 三条出路（不再沉默）');
  } else bad('没采到帧该有一句话', `rc=${r.status} ${s.slice(-300)}`);
}

{
  /* **插桩那一档也有调用栈**（第一百四十九片第四格）：影子栈本来就在手边，记下来的是
   * **精确**的调用链（权重是微秒的自用时间），不是采样估的。用户那句话是对的：
   * backtrace 不是只有 sample 才做得到。
   * 同时钉住**两张表都在**：按函数那张有「调用次数」（采样永远给不出），
   * 聚合回溯那几张有路径 —— 谁也替不了谁。 */
  const r = omni(['run', PROBE, '--profile', 'cc', '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const hasCounts = /2000\s+hot/.test(s);          /* 探子里 hot 调 2000 次，是确定的 */
  const hasPath = s.includes('main > hot');
  const inMs = s.includes('ms') && !s.slice(s.indexOf('聚合回溯')).includes('帧数');
  if (r.status === 0 && hasCounts && hasPath && inMs) {
    ok('cc 档：按函数那张有调用次数 2000，聚合回溯那几张有精确路径 main > hot（按 ms）');
  } else {
    bad('cc 档该两张表都有', `次数 ${hasCounts} / 路径 ${hasPath} / 单位 ${inMs}\n    ${s.slice(0, 300)}`);
  }
}
{
  /* stub 那一档在**外部 cc** 上也一样有调用栈（生成的 C 是同一份，编译器只是换了台）。 */
  const r = omni(['run', FIB, '--profile', 'stub', '--backend', 'c', '--cc', 'clang']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && s.includes('prof[core]') && /omni_main > u_fib/.test(s)
    && s.includes('调用树')) {
    ok('stub · c 腿（clang）：按函数的账 + 调用栈 + 调用树都在');
  } else bad('stub·c（clang）该有调用栈', `rc=${r.status} ${s.slice(-300)}`);
}

/* ---- 五、**量自己**（第一百五十片）：开关摆在动词前面就是量这一趟 omni 自己
 *
 * 读法与 `node --cpu-prof script.js` 一致：谁在前面就量谁。node 腿上办法是把自己
 * 重新 exec 一遍（V8 采样器只能在启动时开），孩子带一格 `OMNI_PROF_SELF=1` 防递归。 */
{
  const r = omni(['--profile', 'sample', 'emit', 'c', join(ROOT, 'bench', 'fib.js')]);
  const s = `${r.stderr || ''}`;
  const out = `${r.stdout || ''}`;
  /* 三件事一起判：量的是**自己**（表头那句）、五张表在、**孩子的产物没被吃掉**。 */
  if (r.status === 0 && s.includes('量自己') && s.includes('函数表') && s.includes('热路径')
    && out.includes('#include "omni.h"')) {
    ok('omni --profile sample emit c …：量自己，五张表在，产物照旧从 stdout 出');
  } else bad('量自己那一格', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  /* `--profile-out` 那一趟只落折叠栈（与量别人那一路同一条规矩）。 */
  const out = join(WORK, 'self.folded');
  rmSync(out, { force: true });
  const r = omni(['--profile', 'sample', '--profile-out', out, 'emit', 'c',
    join(ROOT, 'bench', 'fib.js')]);
  const s = `${r.stderr || ''}`;
  if (r.status === 0 && existsSync(out) && readFileSync(out, 'utf8').includes(';')
    && !s.includes('热路径')) {
    ok('量自己 + --profile-out：只落折叠栈（回头 `omni flame --table` 去看）');
  } else bad('量自己的 --profile-out', `rc=${r.status} ${s.slice(0, 200)}`);
}
{
  /* 量自己那一格 node 腿上只有 sample —— cc/stub 是量**被编译的程序**用的，明着说。 */
  const r = omni(['--profile', 'cc', 'emit', 'c', join(ROOT, 'bench', 'fib.js')]);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && s.includes('量自己') && s.includes('sample')) {
    ok('量自己 --profile cc：说清那一档是量被编译的程序用的');
  } else bad('量自己该只认 sample', `rc=${r.status} ${s.slice(0, 300)}`);
}

{
  /* **stub 也有调用栈**（第一百五十片）：这份 C 是我们自己发的，enter/exit 那一对与
   * 影子栈都在手里 —— 「不能改源码」在 self 这一侧根本不成立。判据是三件事一起：
   * 按函数那张表（含**调用次数**）还在、聚合回溯那几张有路径、而且**`--cc self` 也编得过**
   * （生成的那段 C 要能被我们自己那台 C 前端读）。 */
  const r = omni(['run', FIB, '--profile', 'stub', '--backend', 'c', '--cc', 'self']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const hasCalls = /635621\s+u_fib/.test(s);
  const hasPath = /omni_main > u_fib/.test(s);
  if (r.status === 0 && hasCalls && hasPath && s.includes('折叠栈写到了')) {
    ok('stub · c 腿：按函数的表（635621 次）+ 精确调用栈（omni_main > u_fib），--cc self 也编得过');
  } else bad('stub 该有调用栈', `次数 ${hasCalls} / 路径 ${hasPath}\n    ${s.slice(-300)}`);
}

{
  /* **`.c` 输入 + `--cc self` 上的采样**（第一百五十片第二格）：一个外部编译器都不借。
   * 用户那句话：部署的机器不一定有外部 cc —— 而采样要的两样我们自己都有
   * （编收集器 + 启动时开采样；后者靠 `-Dmain=omni_user_main` 换名 + 自己发一格 main）。 */
  const r = omni(['run', PROBE, '--profile', 'sample:997', '--cc', 'self']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  const rows = topRows(s);
  const first = rows.length > 0 ? rows[0][rows[0].length - 1] : '';
  if (r.status === 0 && first === 'hot' && /omni_user_main/.test(s) && s.includes('热路径')) {
    ok('.c 输入 + --cc self 采样：榜首 hot，栈上看得见我们那格 main 包装（零外部 cc）');
  } else bad('self 那条路该量得到', `rc=${r.status} 榜首=${first}\n    ${s.slice(-300)}`);
}
{
  /* `.c` + stub + `--cc self`：**两个名字落到同一台机器上** —— 我们自己那台 C 前端插的桩
   * （第一百五十片第三格）。从前这一格判的是"要报错"，那句话作废了：用户说得对，
   * 我们用 js 实现了完整的 tcc，`-finstrument-functions` 不是别人才有的开关。 */
  const r = omni(['run', PROBE, '--profile', 'stub', '--cc', 'self']);
  const s = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && /2000\s+hot/.test(s) && /main > hot/.test(s)) {
    ok('.c 输入 + stub + --cc self：我们自己插的桩（hot 2000 次 + main > hot），零外部 cc');
  } else bad('.c + stub + self 该量得到', `rc=${r.status} ${s.slice(-400)}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
