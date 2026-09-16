// tests/graph/run.js —— 节点的判据：**语言 × 后端的矩阵，输出逐行相同**
//
// 一门语言一份 `examples/<家族>.*`（形状随它自己的写法），期望输出**一个家族一份**，
// 家族里所有语言、所有后端共用。现在七个家族：
//
//     basics 15/120/7/ok · multi 3/7/1 2 · defer in/b/a/out · record 1/5/6
//     index 10/30/45 · loopexit 12/6/8 · intmath 15/120
//
// 三条轴各自的意思：
//   * 横着看（语言）：`docs/design/node-graph-contract.md` §1 —— 同一张节点清单承载不同语言。
//   * 竖着看（后端）：§6 —— 后端只回答五问，**同一张图在每个后端上的可观察行为必须一致**。
//   * 第三档 **skip**：后端接不住的形状要**有名有姓**地跳过（§6 第 2 条）——
//     跳过不是失败，它是算出来的待办。`wat` 那条腿现在就有 10 格缺口。
// 加一门语言或加一个后端，矩阵自动多一行/一列 —— 这就是"自动覆盖全部后端"的确切含义。
//
//   node tests/graph/run.js            全跑（末尾按后端印一行覆盖率）
//   node tests/graph/run.js --sx chez  顺带把那门语言的图印成 sx（人看的）
//   node tests/graph/run.js --gaps     印每个后端接不住的节点清单
//   node tests/graph/run.js --machines 印每格节点的**提供者名单**（G5 那条判据）
//
// **第十门 cpp 后来进来了，而它当初进不来的理由与后来进得来的理由都是量出来的**：
// 头一版拿 7 行的 `int sumto(int n) { … }` 去过 `ext/cpp/cpp.grammar`，报
// "too many concurrent parses" —— 连这么短的程序都过不去。把三类歧义一类一类量下来，
// 两类根本不是机制欠账，是**语法自己写松了**（`specs` 允许两格 type-spec；`stmt` 收了
// 函数定义，而 C++ 没有嵌套函数），改在语法里；第三类（`T * x;`）才是真要驱动器回问
// 一句"这个名字登记成类型了吗"（附录 A.5 第 3 笔账），这一批用一格 `(prefer 1)` 偏
// 表达式挡着，**代价写在语法里**，而且被 `tests/grammar/delete.js` 数了出来（那两份例子
// 的基线树是 prefer 挑的）。所以 cpp 现在进矩阵，`ext/cpp/examples/basics.cpp` 与另外
// 九门同一份期望输出 `15 / 120 / 7 / ok`。

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { toSx } from '../../src/core/graph/graph.js';
import { backends, gaps, shapeGaps, Gap } from '../../src/core/graph/contract.js';
// 例子表两条判据共用一份（`delete.js` 也 import 它）—— 抄两份就会有一份忘了改
import { CASES, HAND } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;

const argv = process.argv.slice(2);
const showSx = argv.includes('--sx');
const showGaps = argv.includes('--gaps');
const showMachines = argv.includes('--machines');
/** 每格节点用了它的语言名单 —— **数出来的**，不是手写的（ADR-0033 §3.7 的 G5）。 */
const providers = new Map();
function countOps(x, lang) {
  if (x === null || x === undefined) return;
  if (Array.isArray(x)) { x.forEach((y) => countOps(y, lang)); return; }
  if (x.kind === 'graph') { countOps(x.body, lang); return; }
  if (x.op === undefined) return;
  if (!providers.has(x.op)) providers.set(x.op, new Set());
  providers.get(x.op).add(lang);
  Object.values(x.ins).forEach((y) => countOps(y, lang));
}
const only = argv.filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
let skipped = 0;
/** 每个后端的覆盖（**比覆盖，不比优劣** —— 契约那一节的原话）。 */
const cov = new Map();
const tally = (name, kind) => {
  if (!cov.has(name)) cov.set(name, { ok: 0, skip: 0, fail: 0 });
  cov.get(name)[kind] += 1;
};

if (showGaps) {
  for (const b of backends()) {
    const g = gaps(b.name);
    const sh = shapeGaps(b.name);
    process.stdout.write(`${b.name}: ${g.length === 0 ? '节点级没有缺口' : `${g.length} 格节点接不住`}`
      + `${sh.length === 0 ? '' : ` · ${sh.length} 条形状上的账`}\n`);
    for (const x of g) process.stdout.write(`    ${x.op} —— ${x.why}\n`);
    // 形状上的账要一起印 —— 不然"节点级没有缺口"会盖住矩阵里还在跳的格子
    for (const x of sh) process.stdout.write(`    〔形状〕${x.what} —— ${x.why}\n`);
  }
  process.stdout.write('\n');
}

/**
 * 一张图 × 每个后端。语言那一侧与"手搭图"那一侧共用它 ——
 * 判据只有一条：**同一张图，每个后端的可观察行为必须一致**。
 */
function check(name, g, expect) {
  for (const b of backends()) {
    const label = `${name} × ${b.name}`;
    let art = null;
    try {
      art = b.lower(g);
    } catch (err) {
      // **缺口不是失败**：后端说不出口的形状要有名有姓地跳过（§6 第 2 条纪律）
      if (err instanceof Gap) {
        process.stdout.write(`  skip ${label}：${err.message}\n`); skipped++; tally(b.name, 'skip');
      } else { process.stdout.write(`  FAIL ${label}: ${err.message}\n`); fail++; tally(b.name, 'fail'); }
      continue;
    }
    if (b.runnable === false) {
      // 只序列化的后端（sx）只对"出得来、且不空"负责 —— 它不承诺跑
      if (typeof art.text === 'string' && art.text.length > 0) {
        process.stdout.write(`  ok   ${label} [序列化 ${art.text.split('\n').length} 行]\n`); pass++; tally(b.name, 'ok');
      } else { process.stdout.write(`  FAIL ${label}: 序列化出来是空的\n`); fail++; tally(b.name, 'fail'); }
      continue;
    }
    try {
      const { out } = art.run();
      const got = out.join(' / ');
      const want = expect.join(' / ');
      if (got === want) { process.stdout.write(`  ok   ${label} [${got}]\n`); pass++; tally(b.name, 'ok'); } else {
        process.stdout.write(`  FAIL ${label}\n       期望 ${want}\n       得到 ${got}\n`);
        fail++; tally(b.name, 'fail');
      }
    } catch (err) {
      process.stdout.write(`  FAIL ${label}: ${err.message}\n`);
      fail++; tally(b.name, 'fail');
    }
  }
}

for (const c of CASES) {
  if (only.length > 0 && !only.includes(c.name)) continue;
  let g = null;
  try {
    const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
    const text = readText(`${ROOT}${c.file}`);
    const diags = new Diagnostics();
    const toks = lexText(tb.grammar.lex, new SourceFile(c.file, text), diags);
    if (toks === null || diags.hasErrors()) throw new Error(`词法炸了：${diags.items[0]?.msg}`);
    const tree = glrParse(tb, toks, diags);
    if (tree === null || diags.hasErrors()) throw new Error(`语法炸了：${diags.items[0]?.msg}`);
    g = c.toGraph(tree);
    countOps(g, c.name.split('+')[0]);
    if (showSx) process.stdout.write(`\n---- ${c.name} ----\n${toSx(g)}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL graph/${c.name}（树 -> 图）: ${err.message}\n`);
    fail++;
    continue;
  }

  check(c.name, g, c.expect);
}

// ---- 手搭的图：**没有哪门语言的语法能直说的那几条调度器语义** --------------------
//
// 为什么不写成某门语言的例子：go / V 的 `defer` 是**函数**作用域、nim 的是块作用域，
// 而图上 `scope-exit` 挂的是"最近的一格 region"—— 拿它们的语法当例子会把语义写歪
// （那笔账记在 `docs/design/node-graph-contract.md` A.6.1）。这几条是**节点自己的**
// 语义，所以直接搭图，两个能跑的后端必须给同一个答案。
for (const c of HAND) {
  if (only.length > 0 && !only.includes(c.name)) continue;
  check(c.name, c.graph(), c.expect);
}

if (showMachines) {
  // G5：一格节点的提供者名单。**只有一家的不算机器**（ADR-0033 §3.7 / §5 同一条纪律）。
  process.stdout.write('\n每格节点的提供者名单（数出来的）：\n');
  const rows = [...providers.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [op, langs] of rows) {
    const mark = langs.size >= 4 ? '机器' : (langs.size >= 2 ? '能力' : '一家');
    process.stdout.write(`  ${String(langs.size).padStart(2)} ${mark}  ${op.padEnd(11)}${[...langs].sort().join(' ')}\n`);
  }
}

// 每个后端一行覆盖率。**后端之间不比优劣，比覆盖**（契约那一节的原话）——
// 这一行就是那句话的可执行版本：跑通几格、因为什么跳过几格、缺口几格。
process.stdout.write('\n每条腿的覆盖（比覆盖，不比优劣）：\n');
for (const b of backends()) {
  const c = cov.get(b.name) ?? { ok: 0, skip: 0, fail: 0 };
  const total = c.ok + c.skip + c.fail;
  const tail = b.runnable === false ? '（只序列化，不承诺跑）'
    : (c.skip === 0 ? '' : `，${c.skip} 格跳过（节点级缺口 ${gaps(b.name).length} 格`
      + ` · 形状上的账 ${shapeGaps(b.name).length} 条）`);
  process.stdout.write(`  ${b.name.padEnd(7)}${c.ok}/${total} 跑通${tail}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed, ${skipped} skipped（缺口，有名有姓）`
  + `（语言例子 ${CASES.length} + 手搭图 ${HAND.length}，× 后端 ${backends().length}）\n`);
if (fail > 0) process.exit(1);
