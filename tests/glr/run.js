#!/usr/bin/env node
// Omni — GLR（第八条测试轴，ADR-0014 决策 2）
//
// 「加一门语言 = 一份 grammar + 一份映射标注」这句话要立得住，得先证四件事：
//
//   1. **表是稳定的**：dumpTable 的输出对上 snapshots/NAME.table。快照测试在这里不是懒 ——
//      项集族、FOLLOW、优先级消歧三者任一改错，症状都是"某个输入分析结果变了"，那种错
//      看不出根因。表钉住了，根因就在表的 diff 里。
//   2. **冲突处刻意分叉**：lookahead.grammar 是 SLR(1) 不够但语言不歧义的形状，
//      两条输入分别走冲突的两支，两条都要过。只过一条 = 驱动退化成 LR 了。
//   3. **真歧义要报错，不许猜**：dangling.grammar 不加优先级，
//      `if a then if b then x else y` 必须撞上 bison 的那条硬边界。
//   4. **真实语料一份不落**：asymptote 自带的 84 个 .asy 模块全都要出且只出一棵树。
//      前三条测的是机制，这一条测的是覆盖 —— 自己挑的片段挑不到的地方就是漏的地方。
//   5. **缓存与构表等价**：构表是这条路上唯一的慢步（asy 那份 780ms），结果按语法文本
//      内容寻址缓存在 tmp 里。跑两遍，第二遍必须命中缓存，且两遍的表逐字节相同。
//
// 每条都走 CLI（`omni glr-table` / `omni glr`），不是直接调库函数：这样同一条命令
// 自举链里能让原生编译器再跑一遍，封闭 ABI 违规才有地方被抓住。
//
//   node tests/glr/run.js
//   node tests/glr/run.js expr
//   UPDATE=1 node tests/glr/run.js      重写快照

import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../../stage0/src/cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const update = process.env.UPDATE === '1';
const dir = mkdtempSync(join(tmpdir(), 'omni-glr-'));
mkdirSync(join(here, 'snapshots'), { recursive: true });

const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
// 期望值写成一行，实际输出会按 96 列折行（printSexpr 的排版），所以比较前把空白压平。
// 折行位置不是这条轴要测的东西 —— 树的形状才是。
const norm = (s) => s.trim().replace(/\s+/g, ' ');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };

// asy 那份语法**不在** grammars/ 下：它是前端的一部分（stage0/src/frontend-asy/asy.grammar），
// 因为 `omni run x.asy` 要读同一份文件 —— 语法是那门语言的前端，不是这条轴的测试夹具。
// 这条轴照旧管它（表快照、cases、语料覆盖三节都算在内）。
const FRONTEND_GRAMMARS = new Map([
  ['asy.grammar', join(here, '..', '..', 'stage0', 'src', 'frontend-asy', 'asy.grammar')],
]);
const gpathOf = (file) => FRONTEND_GRAMMARS.get(file) ?? join(here, 'grammars', file);

const grammars = [...readdirSync(join(here, 'grammars')).filter((f) => f.endsWith('.grammar')), ...FRONTEND_GRAMMARS.keys()].sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

// ------------------------------------------------------------ 1. 表的快照

// 状态数超过这个门槛就只快照摘要（产生式表 + 剩下的冲突）。asy 那份语法有 429 个状态，
// 整表印出来是半兆文本，进仓库不合适 —— 而回归真正要盯的就是那两段。
const FULL_DUMP_STATES = 64;

for (const file of grammars) {
  const name = basename(file, '.grammar');
  const gpath = gpathOf(file);
  let r = run(['glr-table', gpath, '--brief']);
  if (r.code === 0) {
    const m = /(\d+) states/.exec(r.out.split('\n')[0]);
    if (m !== null && Number(m[1]) <= FULL_DUMP_STATES) r = run(['glr-table', gpath]);
  }
  if (r.code !== 0) {
    no(`table/${name}`, `    glr-table exit=${r.code}\n${r.err}`);
    continue;
  }
  const snap = join(here, 'snapshots', `${name}.table`);
  const want = read(snap);
  if (update || want === null) {
    writeFileSync(snap, r.out);
    ok(`table/${name} [snapshot ${want === null ? 'created' : 'updated'}] ${r.out.split('\n').length - 1} lines`);
    continue;
  }
  if (r.out !== want) {
    no(`table/${name}`, `    the table changed; rerun with UPDATE=1 if that was intended\n${firstDiff(want, r.out)}`);
    continue;
  }
  ok(`table/${name} [== snapshots/${name}.table] ${r.out.split('\n').length - 1} lines`);
}

/** 快照对不上时印第一处不同就够了 —— 整份表贴出来没人读 */
function firstDiff(want, got) {
  const a = want.split('\n');
  const b = got.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return `    line ${i + 1}\n    want: ${JSON.stringify(a[i] ?? '<eof>')}\n    got:  ${JSON.stringify(b[i] ?? '<eof>')}`;
  }
  return '    (the files differ only in trailing bytes)';
}

// -------------------------------------------------- 1b. 构表结果的缓存要等价
//
// 构表是这条路上唯一的慢步（asy 那份 780ms），所以结果按语法文本内容寻址缓存在
// tmp 里（cli.js loadGrammar）。这一节盯的是**缓存路径与构表路径给同一张表**：
// 跑两遍 `glr-table`，第二遍必须报 cache hit，而且两遍的表逐字节相同。
// 上面那一节其实已经间接管着这件事（快照是构表出来的，缓存错了就对不上），
// 这一节把它变成"当场、明确"的一条 —— 缓存的坑（例如 nonassoc 留下的**空**动作格
// 被读成一条 reduce）不该等到某个用例的分析结果变了才被发现。
for (const file of grammars) {
  const name = basename(file, '.grammar');
  const gpath = gpathOf(file);
  const a = run(['glr-table', gpath, '--brief', '--verbose']);
  const b = run(['glr-table', gpath, '--brief', '--verbose']);
  if (a.code !== 0 || b.code !== 0) {
    no(`cache/${name}`, `    glr-table exit=${a.code}/${b.code}\n${a.err}${b.err}`);
    continue;
  }
  if (!b.err.includes('cache hit')) {
    no(`cache/${name}`, `    第二遍没有命中缓存 —— 那条路就没被测到\n${b.err}`);
    continue;
  }
  if (a.out !== b.out) {
    no(`cache/${name}`, `    缓存读回来的表与构出来的不同\n${firstDiff(a.out, b.out)}`);
    continue;
  }
  ok(`cache/${name} [缓存命中，与构表逐字节相同]`);
}

// ------------------------------------------------------------ 2. 分析：每行一条 case

for (const file of grammars) {
  const name = basename(file, '.grammar');
  const text = read(join(here, 'cases', `${name}.cases`));
  if (text === null) {
    no(`cases/${name}`, `    missing cases/${name}.cases`);
    continue;
  }
  const gpath = gpathOf(file);
  const bad = [];
  const lines = text.split('\n');
  // 该过的那些**一条命令批着跑**：真实语言的表有几百个状态，建一次一两秒，逐条 spawn
  // 的话这一条轴要跑几分钟。该拒的那几条数量少，还是逐条跑 —— 要的就是那句错误文本。
  const okCases = [];
  let errCases = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || line.startsWith(';;')) continue;
    const isErr = line.includes('!!>');
    const at = line.indexOf(isErr ? '!!>' : '==>');
    if (at < 0) {
      bad.push(`    line ${li + 1}: neither '==>' nor '!!>' on a non-comment line`);
      continue;
    }
    const input = line.slice(0, at).trim();
    const want = line.slice(at + 3).trim();
    const ipath = join(dir, `${name}-${li}.in`);
    writeFileSync(ipath, input + '\n');
    if (!isErr) { okCases.push({ li, input, want, ipath }); continue; }
    errCases++;
    const r = run(['glr', gpath, ipath]);
    if (r.code === 0) bad.push(`    line ${li + 1}: ${JSON.stringify(input)} should have been rejected, but it parsed as ${r.out.trim()}`);
    else if (!r.err.includes(want)) bad.push(`    line ${li + 1}: ${JSON.stringify(input)} was rejected for the wrong reason\n      want: ${JSON.stringify(want)}\n      got:  ${r.err.trim()}`);
  }
  if (okCases.length > 0) {
    const r = run(['glr', gpath, ...okCases.map((c) => c.ipath)]);
    if (r.code !== 0) {
      // 批跑时一条挂了整批就停，错误文本里带着是哪个文件 —— 够定位
      bad.push(`    the batch stopped on a failing input\n${r.err}`);
    } else {
      const got = splitBatch(r.out, okCases.map((c) => c.ipath));
      for (const c of okCases) {
        const g = got.get(c.ipath);
        if (g === undefined) bad.push(`    line ${c.li + 1}: ${JSON.stringify(c.input)} produced no tree`);
        else if (norm(g) !== norm(c.want)) bad.push(`    line ${c.li + 1}: ${JSON.stringify(c.input)}\n      want: ${norm(c.want)}\n      got:  ${norm(g)}`);
      }
    }
  }
  if (bad.length === 0) ok(`cases/${name} [${okCases.length} accepted, ${errCases} rejected]`);
  else no(`cases/${name}`, bad.join('\n'));
}

/** 批跑的输出按 `;; ==== 路径` 切开。只有一条输入时 CLI 不印那行，所以单独处理。 */
function splitBatch(out, paths) {
  const byPath = new Map();
  if (paths.length === 1) {
    byPath.set(paths[0], out);
    return byPath;
  }
  let cur = null;
  const buf = [];
  const flush = () => { if (cur !== null) byPath.set(cur, buf.join('\n')); buf.length = 0; };
  for (const line of out.split('\n')) {
    if (line.startsWith(';; ==== ')) { flush(); cur = line.slice(8); continue; }
    buf.push(line);
  }
  flush();
  return byPath;
}

// ------------------------------------------------------------ 3. lookahead 必须留下冲突
//
// 反向的门槛：如果哪天有人把表升级成 LALR，这条会红。那不是坏事 —— 它提醒你
// 这份 case 的意义（"冲突处两支都要活"）已经换了地方，得另找一份语法来担。

if (grammars.includes('lookahead.grammar')) {
  const r = run(['glr-table', gpathOf('lookahead.grammar')]);
  if (r.out.includes('conflicts left to the GLR driver: none')) {
    no('lookahead/has-conflicts', '    this grammar is supposed to be beyond SLR(1), but the table came out clean');
  } else {
    ok('lookahead/has-conflicts [the driver really does the splitting]');
  }
}

// ------------------------------------------------------------ 4. asy 真实语料的覆盖率
//
// 这一节是「完整等效实现」的第一道**可量**门槛：asymptote 自带的那批 .asy 模块，
// 一份不落地都要出一棵树。cases/asy.cases 里的片段证不了这件事 —— 它们是我自己挑的，
// 挑不到的地方就是覆盖不到的地方（第一次量出来只有 32/84 过，`operator` 一族全缺）。
//
// 语料在机器上（asymptote 装了才有），所以找不到就跳过，跳过要说清楚：这条轴不能
// 因为"没装 asymptote"而假装绿。找到了就一条命令批着跑，`--count` 只印摘要 ——
// 84 个模块的树印出来是 133 MB，光排版就 33 秒，摘要 1.8 秒。

const ASY_DIRS = [
  process.env.ASY_LIB ?? '',
  '/opt/homebrew/opt/asymptote/share/asymptote',
  '/usr/local/share/asymptote',
  '/usr/share/asymptote',
];

if (grammars.includes('asy.grammar')) {
  let mods = null;
  let from = null;
  for (const d of ASY_DIRS) {
    if (d === '') continue;
    let names = null;
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    const asy = names.filter((f) => f.endsWith('.asy')).sort();
    if (asy.length === 0) continue;
    mods = asy.map((f) => join(d, f));
    from = d;
    break;
  }
  if (mods === null) {
    process.stdout.write('  skip corpus/asy [no asymptote module directory found; set ASY_LIB]\n');
  } else {
    const r = run(['glr', gpathOf('asy.grammar'), ...mods, '--count']);
    const lines = r.out.split('\n').filter((l) => l.trim() !== '');
    if (r.code !== 0) {
      // 批跑撞到第一个不过的就停。诊断里带着 `文件:行:列`，够定位；后面还有几个不知道，
      // 所以把"已经过了几个"一起印出来。
      no('corpus/asy', `    ${lines.length}/${mods.length} modules parsed, then the batch stopped\n${r.err.split('\n').slice(0, 4).map((l) => `    ${l}`).join('\n')}`);
    } else if (lines.length !== mods.length) {
      no('corpus/asy', `    expected ${mods.length} summary lines, got ${lines.length}`);
    } else {
      ok(`corpus/asy [${mods.length}/${mods.length} modules, one tree each] ${from}`);
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
