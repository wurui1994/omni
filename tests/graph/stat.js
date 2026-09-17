#!/usr/bin/env node
// tests/graph/stat.js —— **图的形状与结构那把尺子自己得先对**（第一百四十七片第三格）
//
// `src/core/graph/stat.js` 是「变换是减法」（`docs/design/node-graph-shrink.md` 第三条）的量尺。
// 尺子要先能证明自己：**数得对、两遍一样、看得见共享、减法是减法**。
// 这一格判据管四件事，每件都有一个能算在手上的期望值：
//
//   1. 数得对      手搭的小图，节点/边/字面量/纯与有效应都是**手数出来的常数**
//   2. 共享只算一次 同一格节点被两处引用：节点 +0、边 +1（图是 DAG，不是树）
//   3. 两遍一样    同一份结构搭两遍（`id` 不同），三种印法逐字节相同 —— 不然两张表没法比
//   4. 减法是减法  同一张图自减全零；删掉一格 `const` 就报 `-1 const`，不多不少
//
// 外加一格**端到端**：`--stat` 印到 stderr，**stdout 一个字节都不许变** ——
// 可观测性不许改变被观测的东西（这条要是破了，判据矩阵会跟着一起烂）。
//
//   node tests/graph/stat.js
//   node tests/graph/stat.js 共享

import { spawnSync } from 'node:child_process';
import { node, lit, program } from '../../src/core/graph/graph.js';
import {
  graphStat, graphStatTable, graphStatJson, graphStatDot, graphStatDiff, graphStatDiffTable,
} from '../../src/core/graph/stat.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
let pass = 0;
let fail = 0;
const want = (s) => only.length === 0 || only.some((x) => s.includes(x));
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };
const eq = (label, got, exp) => {
  if (!want(label)) return;
  if (got === exp) ok(`${label} [${got}]`);
  else no(label, `要 ${exp}，得 ${got}`);
};

const num = (v) => node('const', {}, { value: v });

/* ---- 1) 数得对：一张手数得过来的小图
 *
 *   print(1 + 2) ；那格 `+` 的右边是**内联字面量**（不占节点，`lit(2)`）
 * 手数：节点 3 格（prim print、prim +、const 1）、边 2 条、内联字面量 1 个。
 * `prim` 那一族在 `nodes.js` 里算有效应（内建的效应看名字），所以纯 0 / 有效应 3。 */
const tiny = () => program([
  node('prim', { args: [node('prim', { args: [num(1), lit(2)] }, { name: '+' })] }, { name: 'print' }),
]);
{
  const s = graphStat(tiny());
  eq('数得对〔节点〕', s.nodes, 3);
  eq('数得对〔边〕', s.edges, 2);
  eq('数得对〔内联字面量〕', s.lits, 1);
  eq('数得对〔纯 + 有效应 = 节点〕', s.pure + s.effect, s.nodes);
  eq('数得对〔op 分布：prim:print〕', s.ops.get('prim:print'), 1);
  eq('数得对〔op 分布：prim:+〕', s.ops.get('prim:+'), 1);
  eq('数得对〔深度〕', s.depth, 3);
}

/* ---- 2) 共享只算一次：一格 `const` 挂到两处
 *
 * 这条是**图与树的分水岭**：树上这就是两格，图上是一格被引用两次。
 * 「可共享」正是 `prims.js` 里 pure 那一栏声明的本钱，数节点要是按出现次数数，
 * 那本钱就被记成了负债。 */
{
  const shared = num(7);
  const g = program([node('prim', { args: [shared, shared] }, { name: 'print' })]);
  const s = graphStat(g);
  eq('共享〔节点：一格算一次〕', s.nodes, 2);
  eq('共享〔边：两条都算〕', s.edges, 2);
  eq('共享〔const 只有一格〕', s.ops.get('const'), 1);
}

/* ---- 3) 两遍一样：同一份结构搭两遍（节点 `id` 是全局计数器，必然不同）
 *
 * 三种印法都要逐字节相同。dot 那一份**印的是 id**，所以它天然不满足 ——
 * 那不是 bug 而是它的用途（看这一张图的结构），于是这儿只要求表与 json。 */
{
  const a = graphStat(tiny());
  const b = graphStat(tiny());
  eq('两遍一样〔表〕', graphStatTable(a), graphStatTable(b));
  eq('两遍一样〔json〕', graphStatJson(a), graphStatJson(b));
  if (want('两遍一样〔json 的键按名字排〕')) {
    const keys = Object.keys(JSON.parse(graphStatJson(a)).ops);
    const sorted = [...keys].sort();
    if (keys.join(',') === sorted.join(',')) ok('两遍一样〔json 的键按名字排 —— 工具吃它，次序要定〕');
    else no('两遍一样〔json 的键按名字排〕', `得 ${keys.join(',')}`);
  }
}

/* ---- 4) 减法是减法 */
{
  const base = graphStat(tiny());
  const same = graphStatDiff(base, graphStat(tiny()));
  eq('减法〔自减：节点 0〕', same.nodes, 0);
  eq('减法〔自减：一格 op 都没变〕', same.ops.length, 0);
  if (want('减法〔自减那句话〕')) {
    const t = graphStatDiffTable(same);
    if (t.includes('一格都没变')) ok('减法〔自减那句话：一格都没变〕');
    else no('减法〔自减那句话〕', JSON.stringify(t));
  }
  /* 把那格 `const 1` 换成内联字面量：节点 -1、`const` -1、内联字面量 +1。
   * 这正是 shrink 文档第二节那笔账（「装箱一个字面量在这儿看得见」）的方向。 */
  const shrunk = program([
    node('prim', { args: [node('prim', { args: [lit(1), lit(2)] }, { name: '+' })] }, { name: 'print' }),
  ]);
  const d = graphStatDiff(base, graphStat(shrunk));
  eq('减法〔拆掉一格 const：节点 -1〕', d.nodes, -1);
  eq('减法〔拆掉一格 const：边 -1〕', d.edges, -1);
  eq('减法〔拆掉一格 const：内联字面量 +1〕', d.lits, 1);
  eq('减法〔按 op：只有 const 变了〕', d.ops.map((r) => r.join('')).join(' '), 'const-1');
  if (want('减法〔印法：- 是缩〕')) {
    const t = graphStatDiffTable(d);
    if (t.includes('-1') && t.includes('const')) ok('减法〔印法：- 是缩，const 那行在〕');
    else no('减法〔印法：- 是缩〕', JSON.stringify(t));
  }
}

/* ---- 5) dot：印得下就印全，印不下要**说**自己没印全（不许悄悄截断） */
{
  const g = tiny();
  if (want('dot〔印得全〕')) {
    const t = graphStatDot(g);
    /* 只数**方框**那几行：边上也带 `label=`（端口名），一起数就把 3 格数成 5 格了。 */
    const boxes = t.split('\n').filter((l) => /^ {2}g\d+ \[label=/.test(l)).length;
    if (boxes === 3 && !t.includes('还有更多')) ok('dot〔印得全：3 个方框，没有省略那行〕');
    else no('dot〔印得全〕', `${boxes} 个方框；${t.includes('还有更多') ? '还多了省略那行' : ''}`);
  }
  if (want('dot〔印不下就说〕')) {
    const t = graphStatDot(g, 2);
    if (t.includes('还有更多')) ok('dot〔印不下就说 —— 不许悄悄截断〕');
    else no('dot〔印不下就说〕', '截断了却没那一行');
  }
}

/* ---- 6) 端到端：`--stat` 只往 stderr 写，stdout 一个字节都不许变
 *
 * 这条是这一格存在的前提：可观测性不许改变被观测的东西。stdout 上是那份程序的输出，
 * 十门语言 × 五个后端的矩阵逐行比对它 —— 多一行就是把整张矩阵拖红。 */
{
  const cli = (args) => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
  const plain = cli(['run', '--engine', 'graph', 'ext/lua/examples/record.lua']);
  const withStat = cli(['run', '--engine', 'graph', 'ext/lua/examples/record.lua', '--stat']);
  eq('端到端〔退出码〕', withStat.status, plain.status);
  eq('端到端〔stdout 一字不变〕', withStat.stdout, plain.stdout);
  if (want('端到端〔stat 印在 stderr〕')) {
    const line = withStat.stderr.split('\n').find((l) => l.includes('图的形状'));
    /* 期望值是**算出来的**，不是抄下来的：这门语言的映射改了，这条判据要跟着动而不是假过。 */
    if (line !== undefined && /节点 \d+ 格、边 \d+ 条/.test(line)) ok(`端到端〔stat 印在 stderr〕[${line.trim()}]`);
    else no('端到端〔stat 印在 stderr〕', JSON.stringify(withStat.stderr.slice(0, 200)));
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（图的形状与结构：数得对 · 共享一次 · 两遍一样 · 减法是减法）\n`);
if (fail > 0) process.exit(1);
