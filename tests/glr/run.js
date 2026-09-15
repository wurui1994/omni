#!/usr/bin/env node
// Omni — GLR（第八条测试轴，ADR-0014 决策 2）
//
// 「加一门语言 = 一份 grammar + 一份映射标注」这句话要立得住，得先证四件事：
//
//   1. **表是稳定的**：dumpTable 的输出对上 snapshots/NAME.table。快照测试在这里不是懒 ——
//      项集族、FOLLOW、优先级消歧三者任一改错，症状都是"某个输入分析结果变了"，那种错
//      看不出根因。表钉住了，根因就在表的 diff 里。
//   2. **冲突处刻意分叉**：lookahead.grammar 是 LALR(1) 不够但语言不歧义的形状，
//      四条输入分别走那对归约/归约冲突的两支，四条都要过。少过一条 = 驱动退化成 LR 了。
//   3. **真歧义要报错，不许猜**：dangling.grammar 不加优先级，
//      `if a then if b then x else y` 必须撞上 bison 的那条硬边界。
//   4. **真实语料一份不落**：asymptote 自带的 84 个 .asy 模块全都要出且只出一棵树。
//      前三条测的是机制，这一条测的是覆盖 —— 自己挑的片段挑不到的地方就是漏的地方。
//   5. **缓存与构表等价**：构表是这条路上唯一的慢步（asy 那份 780ms），结果按语法文本
//      内容寻址缓存在 tmp 里。跑两遍，第二遍必须命中缓存，且两遍的表逐字节相同。
//   6. **别人写好的 .y 直接收**：bison/yacc 的 `.y`（含我们早期那份把词法也写在里头的混合
//      方言）转成同一份 `(grammar …)` 文本再往下走。判据见第 5 节 —— 转出来的文本进快照，
//      表走同一格缓存，有词法段的当场跑 `.cases`，折不动的模式必须当场报错。
//   7. **标准里那份 EBNF 直接收**：`.ebnf`（W3C / bottlecaps 风）走与第 6 条一样的路。
//      多测一件事：`?` `*` `+` 与分组在**转换期**展开成辅助规则，同形状只出一份。
//      这一支没有词法段，所以判据的第三条反过来 —— 它必须拒绝直接吃源文本。
//
// 每条都走 CLI（`omni glr-table` / `omni glr`），不是直接调库函数：这样同一条命令
// 自举链里能让原生编译器再跑一遍，封闭 ABI 违规才有地方被抓住。
//
//   node tests/glr/run.js
//   node tests/glr/run.js expr
//   UPDATE=1 node tests/glr/run.js      重写快照

import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RunCache } from '../lib/incr.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../../src/core/cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const update = process.env.UPDATE === '1';
const dir = workDir('glr');
mkdirSync(join(here, 'snapshots'), { recursive: true });

const cache = new RunCache('glr');
const run = (args) => {
  const r = cache.run([cli, ...args]);
  return { out: r.out, err: r.err, code: r.code };
};
/**
 * **不许缓存**的那一格（ADR-0023：什么不能进缓存）。下面 1b 那一节的判据是
 * "同一条命令跑两遍，第二遍要报 cache hit" —— 它测的正是**第二次调用与第一次不同**
 * 这件事。走缓存的话两次的键一模一样，第二次会把第一次的 stderr 交回来（那里面没有
 * cache hit），于是这一节永远红。所以那两遍走原始 spawn。
 */
const runRaw = (args) => {
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

// asy 与 jnc 两份语法**不在** grammars/ 下：它们是前端的一部分
// （src/core/frontend-asy/asy.grammar、src/core/frontend-jnc/jnc.grammar），
// 因为 `omni run x.asy` / `x.jnc` 要读同一份文件 —— 语法是那门语言的前端，不是这条轴的
// 测试夹具。这条轴照旧管它们（表快照、cases、语料覆盖三节都算在内）。
const FRONTEND_GRAMMARS = new Map([
  ['asy.grammar', join(here, '..', '..', 'src', 'core', 'frontend-asy', 'asy.grammar')],
  ['jnc.grammar', join(here, '..', '..', 'src', 'core', 'frontend-jnc', 'jnc.grammar')],
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
  const a = runRaw(['glr-table', gpath, '--brief', '--verbose']);
  const b = runRaw(['glr-table', gpath, '--brief', '--verbose']);
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
  const res = caseFailures(name, gpathOf(file), text);
  if (res.bad.length === 0) ok(`cases/${name} [${res.counts}]`);
  else no(`cases/${name}`, res.bad.join('\n'));
}

/**
 * 一份 `.cases` 跑一遍，答 `{bad, counts}`（`bad` 空 = 全过）。
 *
 * 摆成函数是因为第 5 节（`.y`）要的是**同一件事**：同一份语料判据，喂进去的语法一份是
 * `.grammar`、一份是 `.y`。判据只该有一处说法，不然两边会慢慢走散。
 *
 * 该过的那些**一条命令批着跑**：真实语言的表有几百个状态，建一次一两秒，逐条 spawn
 * 的话这一条轴要跑几分钟。该拒的那几条数量少，还是逐条跑 —— 要的就是那句错误文本。
 */
function caseFailures(name, gpath, text) {
  const bad = [];
  const lines = text.split('\n');
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
  return { bad, counts: `${okCases.length} accepted, ${errCases} rejected` };
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
// 反向的门槛：如果哪天有人把表升级得更强（LALR(1) -> 正规 LR(1)），这条会红。那不是坏事 ——
// 它提醒你这份 case 的意义（"冲突处两支都要活"）已经换了地方，得另找一份语法来担。
// 2026-09 从 SLR(1) 升到 LALR(1) 时就红过一次，那一次换掉了 lookahead.grammar 本身。

if (grammars.includes('lookahead.grammar')) {
  const r = run(['glr-table', gpathOf('lookahead.grammar')]);
  if (r.out.includes('conflicts left to the GLR driver: none')) {
    no('lookahead/has-conflicts', '    this grammar is supposed to be beyond LALR(1), but the table came out clean');
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

// ------------------------------------------------- 5. `.y`（bison/yacc）转进来
//
// 「加一门语言 = 一份语法 + 一份映射标注」这句话要站得住，第一步是**别要求先手抄一遍语法**：
// 参考树里躺着的是别人写好的 .y（asymptote 的 parser.y、bison 自带那一批），还有我们早期
// 半成品定下的混合 .y（词法也写在同一份文件里）。glr/yacc.js 把它们转成我们那份
// `(grammar …)` 文本，再走**同一条**路（readGrammar -> buildTable）。
//
// 三条判据，一条比一条硬：
//   a. **转出来的文本对上快照**。这一条不是懒：`.y` 那一层的错（优先级级序、`%prec`、
//      别名、正则折成词法项）在表上表现成"某个输入的分析结果变了"，那种症状没有根因。
//      文本钉住了，根因就在这一份 diff 里。
//   b. **表建得出来，而且第二遍命中缓存**。缓存键是**转出来的**那段文本 —— 这一条盯的是
//      `.y` 与 `.grammar` 走的是同一格缓存，不是另开一条路。
//   c. **有词法段的那份当场能吃源文本**（跑 `.cases`，与第 2 节同一个函数）；没有词法段的
//      那份（真 bison 的词法在 `.l` 里）要**明说**这件事 —— 那不是失败，那是它该有的样子。
//
// 还有一份 ybad.y：正则里写了 `{n,m}`。它必须当场报"不支持"，不许折成一个近似的模式。

const Y_DIR = join(here, 'y');
const yFiles = readdirSync(Y_DIR).filter((f) => f.endsWith('.y')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

for (const file of yFiles) {
  const name = basename(file, '.y');
  const ypath = join(Y_DIR, file);
  /* 快照里不许留绝对路径（转出来的头部注释与诊断都带着它） */
  const unpath = (s) => s.split(ypath).join(`y/${file}`);

  // ---- a) 转出来的文本（或那句诊断）
  const cv = run(['glr', 'y', ypath]);
  const body = `exit=${cv.code}\n${unpath(cv.code === 0 ? cv.out : cv.err)}`;
  const snap = join(here, 'snapshots', `${name}.grammar`);
  const want = read(snap);
  if (update || want === null) {
    writeFileSync(snap, body);
    ok(`y/${name} [snapshot ${want === null ? 'created' : 'updated'}] ${body.split('\n').length - 1} lines`);
  } else if (body !== want) {
    no(`y/${name}`, `    转出来的语法变了；确实是有意改的话用 UPDATE=1 重写\n${firstDiff(want, body)}`);
  } else {
    ok(`y/${name} [== snapshots/${name}.grammar]`);
  }
  if (cv.code !== 0) continue;   // ybad.y 那一份到这儿就完了

  // ---- b) 表建得出来，第二遍走缓存且逐字节相同
  const a = runRaw(['glr', 'table', ypath, '--brief', '--verbose']);
  const b = runRaw(['glr', 'table', ypath, '--brief', '--verbose']);
  if (a.code !== 0 || b.code !== 0) no(`y-table/${name}`, `    glr table exit=${a.code}/${b.code}\n${a.err}${b.err}`);
  else if (!b.err.includes('cache hit')) no(`y-table/${name}`, `    第二遍没有命中缓存 —— .y 那条路没有用上同一格缓存\n${b.err}`);
  else if (a.out !== b.out) no(`y-table/${name}`, `    缓存读回来的表与构出来的不同\n${firstDiff(a.out, b.out)}`);
  else ok(`y-table/${name} [${/(\d+) states/.exec(a.err) === null ? '?' : /(\d+) states/.exec(a.err)[1]} states，缓存命中且逐字节相同]`);

  // ---- c) 有 .cases 就跑；没有就必须说清"这份语法没有词法段"
  const cases = read(join(Y_DIR, `${name}.cases`));
  if (cases === null) {
    const one = join(dir, `${name}.in`);
    writeFileSync(one, '\n');
    const r = run(['glr', ypath, one]);
    if (r.code === 0) no(`y-cases/${name}`, '    这份 .y 没有词法段，却把源文本吃下去了');
    else if (!r.err.includes('has no (lex ...) form')) no(`y-cases/${name}`, `    拒得对，但理由不对\n      got: ${r.err.trim()}`);
    else ok(`y-cases/${name} [没有词法段，说清了]`);
    continue;
  }
  const res = caseFailures(`y-${name}`, ypath, cases);
  if (res.bad.length === 0) ok(`y-cases/${name} [${res.counts}]`);
  else no(`y-cases/${name}`, res.bad.join('\n'));
}

// ------------------------------------------------- 6. 缩进即块结构（词法器那一格 indent）
//
// `.cases` 那套是**一行一条**的，而缩进这件事天生跨行 —— 所以这一节的语料是真文件
// （`tests/glr/indent/*.in`），判据是树的快照。
//
// 四件事要证（语法文件头也写着）：缩进变深/变浅出 INDENT / DEDENT；**空行与纯注释行
// 不出记号**；**括号里面的换行是续行**（不出记号）；文件尾把缩进栈弹空。
// 前三件在 01-blocks.in 与 02-continuation.in 里各占一段。

const IND_DIR = join(here, 'indent');
if (!filters.length || filters.some((x) => 'indent'.includes(x))) {
  const gpath = join(IND_DIR, 'indent.grammar');
  for (const f of readdirSync(IND_DIR).filter((x) => x.endsWith('.in')).sort()) {
    const name = basename(f, '.in');
    const r = run(['glr', gpath, join(IND_DIR, f)]);
    if (r.code !== 0) {
      no(`indent/${name}`, `    glr parse exit=${r.code}\n${r.err}`);
      continue;
    }
    const snap = join(here, 'snapshots', `indent-${name}.tree`);
    const want = read(snap);
    if (update || want === null) {
      writeFileSync(snap, r.out);
      ok(`indent/${name} [snapshot ${want === null ? 'created' : 'updated'}]`);
    } else if (norm(r.out) !== norm(want)) {
      no(`indent/${name}`, `    树变了；确实是有意改的话用 UPDATE=1 重写\n      want: ${norm(want)}\n      got:  ${norm(r.out)}`);
    } else {
      ok(`indent/${name} [== snapshots/indent-${name}.tree]`);
    }
  }
}

// ------------------------------------------------- 7. `.ebnf`（W3C 风）转进来
//
// 与第 5 节是同一件事的另一半，判据也照抄：`.y` 那一支是"别人的**实现**"（bison 那一批），
// `.ebnf` 这一支是"别人的**标准文本**" —— C++11/14/17/20/23、C99/11/17/23 的语法附录本身
// 就是 EBNF。手抄一遍就是抄一遍的错（手写那份 C++ 语法 351 份只过 16，量过）。
//
// 三条判据与 `.y` 一一对应：
//   a. **转出来的文本对上快照**。这一节盯的是展开那一步：`?` `*` `+` 与分组折成辅助规则，
//      同形状只出一份（不然 c++23 那份 304 处 `?` 会生出 304 条一样的规则）。
//   b. **表建得出来，第二遍命中缓存** —— 缓存键是转出来的文本，与 `.grammar` 同一格。
//   c. **一份 .ebnf 不带词法实现**，所以它必须拒绝直接吃源文本，且说清理由。
//      这不是缺陷：EBNF 答"什么串合法"，不答"字符怎么切成记号"。
//
// bad.ebnf 那一份是折不动的（正则字符类），与 ybad.y 同一个位置：当场报错，指到那个字符。

const E_DIR = join(here, 'ebnf');
const eFiles = readdirSync(E_DIR).filter((f) => f.endsWith('.ebnf')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

for (const file of eFiles) {
  const name = basename(file, '.ebnf');
  const epath = join(E_DIR, file);
  const unpath = (s) => s.split(epath).join(`ebnf/${file}`);

  // ---- a) 转出来的文本（或那句诊断）
  const cv = run(['glr', 'ebnf', epath]);
  const body = `exit=${cv.code}\n${unpath(cv.code === 0 ? cv.out : cv.err)}`;
  const snap = join(here, 'snapshots', `ebnf-${name}.grammar`);
  const want = read(snap);
  if (update || want === null) {
    writeFileSync(snap, body);
    ok(`ebnf/${name} [snapshot ${want === null ? 'created' : 'updated'}] ${body.split('\n').length - 1} lines`);
  } else if (body !== want) {
    no(`ebnf/${name}`, `    转出来的语法变了；确实是有意改的话用 UPDATE=1 重写\n${firstDiff(want, body)}`);
  } else {
    ok(`ebnf/${name} [== snapshots/ebnf-${name}.grammar]`);
  }
  if (cv.code !== 0) continue;   // bad.ebnf 到这儿就完了

  // ---- b) 表建得出来，第二遍走缓存且逐字节相同
  const a = runRaw(['glr', 'table', epath, '--brief', '--verbose']);
  const b = runRaw(['glr', 'table', epath, '--brief', '--verbose']);
  const states = /(\d+) states/.exec(a.err);
  if (a.code !== 0 || b.code !== 0) no(`ebnf-table/${name}`, `    glr table exit=${a.code}/${b.code}\n${a.err}${b.err}`);
  else if (!b.err.includes('cache hit')) no(`ebnf-table/${name}`, `    第二遍没有命中缓存 —— .ebnf 那条路没有用上同一格缓存\n${b.err}`);
  else if (a.out !== b.out) no(`ebnf-table/${name}`, `    缓存读回来的表与构出来的不同\n${firstDiff(a.out, b.out)}`);
  else ok(`ebnf-table/${name} [${states === null ? '?' : states[1]} states，缓存命中且逐字节相同]`);

  // ---- c) 没有词法段：必须拒绝源文本，且说清理由
  const one = join(dir, `${name}.ebnf.in`);
  writeFileSync(one, '\n');
  const r = run(['glr', epath, one]);
  if (r.code === 0) no(`ebnf-lex/${name}`, '    一份 .ebnf 没有词法段，却把源文本吃下去了');
  else if (!r.err.includes('has no (lex ...) form')) no(`ebnf-lex/${name}`, `    拒得对，但理由不对\n      got: ${r.err.trim()}`);
  else ok(`ebnf-lex/${name} [没有词法段，说清了]`);
}

const rep = cache.report();
process.stdout.write(`\n${pass} passed, ${fail} failed${rep === '' ? '' : `  （${rep}）`}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
