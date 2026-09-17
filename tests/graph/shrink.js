#!/usr/bin/env node
// tests/graph/shrink.js —— **第一个 pass 的判据**：缩了几格，且五个后端输出一字不变
//
// `docs/design/node-graph-shrink.md` 第五节第 1 条的原话：「常量折叠 + 死绑定删除
// （pure 那一栏的第一个消费者）：`tests/graph` 里现有例子上报出「删了几格」，
// 且五个后端输出一字不变」。这一格就是那条判据，分两层：
//
//   **规则层（手搭的小图）** 每条规则各一格，期望值是手算出来的常数：
//     折得动 / 不该折的不折（内建不 pure、名字不认得）/ 死绑定删掉 /
//     活着的绑定不删 / 初值有效应的绑定不删（删了输出就变了）/ 共享还是共享
//   **矩阵层（现有例子）** 十门语言的**全部**例子，**每条腿跑两遍**（缩前 / 缩后），
//     输出逐格相同；`sx` 那条腿另比一件事（序列化读回来仍然逐字节相同）。
//     全矩阵量过 2.3 秒 / 528 格，所以不挑 —— 挑了只会漏掉没人看着的那几门。
//
// 缩不动不是失败：一份例子里没有常量表达式、也没有死绑定，那就该报 0。可是**全都报 0
// 就是这个 pass 悄悄坏掉了** —— 那 500 多格验的是"输出一字不变"，空操作照样全绿。
// 所以最后一格数「几份缩得动」（量到 16 份，判据写下界 10）。
//
//   node tests/graph/shrink.js
//   node tests/graph/shrink.js strcat

import { spawnSync } from 'node:child_process';
import { loadGrammarTable } from '../../src/core/glr/load.js';import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { node, lit, program } from '../../src/core/graph/graph.js';
import { backends, Gap } from '../../src/core/graph/contract.js';
import { evalGraph } from '../../src/core/graph/eval.js';
import { graphStat } from '../../src/core/graph/stat.js';
import { shrink } from '../../src/core/graph/shrink.js';
import { CASES } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
let pass = 0;
let fail = 0;
const want = (s) => only.length === 0 || only.some((x) => s.includes(x));
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const eq = (label, got, exp) => {
  if (!want(label)) return;
  if (got === exp) ok(`${label} [${got}]`);
  else no(label, `要 ${JSON.stringify(exp)}，得 ${JSON.stringify(got)}`);
};

const num = (v) => node('const', {}, { value: v });
const prim = (name, args) => node('prim', { args }, { name });
const outOf = (g) => evalGraph(g).out.join('|');

// ---- 规则层 ------------------------------------------------------------------

/* 折得动：`print(1 + 2)` —— 那格 `+` 与两格常量塌成一格 `const 3`。 */
{
  const g = program([prim('print', [prim('+', [num(1), lit(2)])])]);
  const before = outOf(g);
  const r = shrink(g);
  eq('折〔折了 1 格〕', r.folded, 1);
  eq('折〔节点 3 -> 2〕', `${graphStat(g).nodes} -> ${graphStat(r.graph).nodes}`, '3 -> 2');
  eq('折〔输出一字不变〕', outOf(r.graph), before);
  eq('折〔算的是同一个 kernel：3〕', outOf(r.graph), '3');
}

/* 一层套一层：`(1+2)*3` 自底向上一趟折到底（不用等下一轮）。 */
{
  const g = program([prim('print', [prim('*', [prim('+', [num(1), num(2)]), num(3)])])]);
  const r = shrink(g);
  eq('折〔套两层：折了 2 格〕', r.folded, 2);
  eq('折〔套两层：9〕', outOf(r.graph), '9');
}

/* 不该折的不折（两条）：内建自己不 pure（`print`）；名字压根不认得。 */
{
  const g = program([prim('print', [num(1)])]);
  const r = shrink(g);
  eq('不折〔print 有效应：折 0〕', r.folded, 0);
  eq('不折〔print 的输出还在〕', outOf(r.graph), '1');
}
{
  /* 不认得的内建：`isPure` 给它最坏情况（reads+writes），所以第一道门就拦住 —— 不许炸。 */
  const g = program([prim('nosuch', [num(1)])]);
  let r = null;
  try {
    r = shrink(g);
  } catch (err) {
    no('不折〔不认得的内建〕', `炸了：${err.message}`);
  }
  if (r !== null) eq('不折〔不认得的内建：折 0，不炸〕', r.folded, 0);
}

/* 死绑定：名字整张图里没人 `ref` / `set`，初值又通体 pure —— 整格删掉。 */
{
  const g = program([
    node('bind', { init: prim('+', [num(1), num(2)]) }, { name: 'unused' }),
    prim('print', [num(7)]),
  ]);
  const before = outOf(g);
  const r = shrink(g);
  eq('删〔死绑定：删 1 格〕', r.dropped, 1);
  eq('删〔输出一字不变〕', outOf(r.graph), before);
  eq('删〔连初值一起走：节点只剩 print 与它的常量〕', graphStat(r.graph).nodes, 2);
}

/* 活着的绑定不删（哪怕只被读一次）。 */
{
  const g = program([
    node('bind', { init: num(5) }, { name: 'x' }),
    prim('print', [node('ref', {}, { name: 'x' })]),
  ]);
  const r = shrink(g);
  eq('不删〔有人 ref：删 0〕', r.dropped, 0);
  eq('不删〔输出还是 5〕', outOf(r.graph), '5');
}

/* **初值有效应的绑定不删** —— 这一格是这条规则的安全网：`local _ = print(1)` 的名字
 * 没人用，可是删掉它那句 `1` 就不印了。effects 那一栏在这儿正是它声明的用途。 */
{
  const g = program([
    node('bind', { init: prim('print', [num(1)]) }, { name: 'unused' }),
    prim('print', [num(2)]),
  ]);
  const r = shrink(g);
  eq('不删〔初值有效应：删 0〕', r.dropped, 0);
  eq('不删〔两句都还在〕', outOf(r.graph), '1|2');
}

/* 共享还是共享：一格常量挂到两处，缩完仍然是**一格**（变换不许把图摊成树）。 */
{
  const shared = num(3);
  const g = program([prim('print', [shared, shared])]);
  const r = shrink(g);
  eq('共享〔缩前 2 格〕', graphStat(g).nodes, 2);
  eq('共享〔缩后还是 2 格，不是 3 格〕', graphStat(r.graph).nodes, 2);
  eq('共享〔输出不变〕', outOf(r.graph), '3 3');
}

/* 只减不增、而且会停：缩两遍与缩一遍一样（第二遍报 0，1 轮就出来）。 */
{
  const g = program([prim('print', [prim('+', [num(1), num(2)])])]);
  const once = shrink(g);
  const twice = shrink(once.graph);
  eq('停〔缩过的再缩：折 0 删 0〕', `${twice.folded} ${twice.dropped}`, '0 0');
  eq('停〔缩过的再缩：1 轮〕', twice.rounds, 1);
}

// ---- 矩阵层：现有例子 × 每条腿，缩前缩后输出逐格相同 --------------------------

/** 一份例子 -> 一张图（与 `tests/graph/run.js` 那一段同一条路）。 */
function graphOf(c) {
  const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
  const diags = new Diagnostics();
  const toks = lexText(tb.grammar.lex, new SourceFile(c.file, readText(`${ROOT}${c.file}`)), diags);
  const tree = glrParse(tb, toks, diags);
  return c.toGraph(tree);
}

/** 一条腿跑一张图。接不住（`Gap`）回 `{gap}` —— 缺口不是失败（与矩阵那条判据一致）。 */
function legOut(back, g) {
  try {
    const art = back.lower(g);
    if (back.runnable === false) {
      /* sx：缩完的图序列化再读回来仍要逐字节相同（那是它在矩阵里的判据）。 */
      const same = typeof art.reread === 'function' ? art.reread() === art.text : true;
      return { sx: same };
    }
    return { out: art.run().out.join('|') };
  } catch (err) {
    if (err instanceof Gap) return { gap: err.message };
    return { bad: err.message };
  }
}

/* **全矩阵**：十门例子 × 五条腿，缩前缩后各跑一遍（量过 2.3 秒 528 格，所以不必挑）。
 * 一开始这儿只挑了三份折得动的，`--all` 才走全矩阵 —— 量下来全矩阵也是秒级，
 * 那"挑"就只剩下"漏掉的那几门没人看着"这一个后果，于是删掉那个开关。
 *
 * 缩不动的例子照样跑两遍：`shrink` 会把整张图**重建**一遍（新的 id、新的节点对象），
 * 所以"一格都没折"的那几份验的是另一件事 —— 重建本身没把图弄坏。 */
let shrunkCases = 0;
for (const c of CASES) {
  if (!want(c.name)) continue;
  let g = null;
  try {
    g = graphOf(c);
  } catch (err) {
    no(`矩阵〔${c.name}〕`, `树 -> 图 炸了：${err.message}`);
    continue;
  }
  const r = shrink(g);
  const s0 = graphStat(g);
  const s1 = graphStat(r.graph);
  if (r.folded + r.dropped > 0) shrunkCases += 1;
  for (const back of backends()) {
    const label = `矩阵〔${c.name} × ${back.name}〕`;
    if (!want(label) && !want(c.name)) continue;
    const a = legOut(back, g);
    const b = legOut(back, r.graph);
    if (a.gap !== undefined || b.gap !== undefined) {
      process.stdout.write(`  skip ${label}：${a.gap ?? b.gap}\n`);
      continue;
    }
    if (a.bad !== undefined || b.bad !== undefined) {
      no(label, `${a.bad ?? b.bad}`);
      continue;
    }
    if (a.sx !== undefined) {
      if (b.sx === true) ok(`${label} [缩完的图序列化读回来仍逐字节相同]`);
      else no(label, '缩完的图 sx 读回来不一样了');
      continue;
    }
    if (a.out !== b.out) {
      no(label, `缩前 ${JSON.stringify(a.out)}，缩后 ${JSON.stringify(b.out)}`);
      continue;
    }
    /* 期望值也一起压住：与 `cases.js` 里那份对不上就不是"缩得对"，是两边一起错。 */
    if (a.out !== c.expect.join('|')) {
      no(label, `与 cases.js 的期望对不上：${JSON.stringify(a.out)} vs ${JSON.stringify(c.expect.join('|'))}`);
      continue;
    }
    ok(`${label} [节点 ${s0.nodes} -> ${s1.nodes}（折 ${r.folded}、删 ${r.dropped}），输出一字不变]`);
  }
}

// ---- 别悄悄变成空操作：得有相当一批例子真的缩得动 ------------------------------
if (want('眼睛〔缩得动的份数〕')) {
  /* 期望值是量出来的（2026-09-17：103 份里 16 份缩得动）。这儿写下界而不是等号：
   * 例子多一份少一份是常事，而"从十几份掉到 0"是这个 pass 悄悄坏掉的样子 ——
   * 上面那 500 多格全是"输出一字不变"，pass 什么都不做时它们照样全绿。 */
  if (shrunkCases >= 10) ok(`眼睛〔缩得动的份数：${shrunkCases} 份（量到 16，下界 10）〕`);
  else no('眼睛〔缩得动的份数〕', `只有 ${shrunkCases} 份缩得动 —— 这个 pass 是不是变成空操作了`);
}

// ---- 开关那一层：`--shrink` 报账在 stderr，stdout 一个字节都不许变 ----------------
{
  const cli = (args) => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
  const base = ['run', '--engine', 'graph', 'ext/lua/examples/strcat.lua'];
  const plain = cli(base);
  const shrunk = cli([...base, '--shrink']);
  eq('开关〔退出码〕', shrunk.status, plain.status);
  eq('开关〔stdout 一字不变〕', shrunk.stdout, plain.stdout);
  if (want('开关〔账印在 stderr〕')) {
    const line = shrunk.stderr.split('\n').find((l) => l.includes('shrink'));
    /* 「报出删了几格」是这个开关的**输出**，不是 -v 才有的调试话（第三条要求的原话）。 */
    if (line !== undefined && /折 \d+ 格常量、删 \d+ 格死绑定/.test(line)) ok(`开关〔账印在 stderr〕[${line.trim()}]`);
    else no('开关〔账印在 stderr〕', JSON.stringify(shrunk.stderr.slice(0, 200)));
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（第一个 pass：折 + 删，五条腿输出一字不变）\n`);
if (fail > 0) process.exit(1);