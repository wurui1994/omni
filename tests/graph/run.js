// tests/graph/run.js —— 第一批节点的判据：**语言 × 后端的矩阵，输出逐行相同**
//
// 一门语言一份 `examples/basics.*`（形状随它自己的写法），期望输出**只有一份**：
//
//     15 / 120 / 7 / ok
//
// 两条轴各自的意思：
//   * 横着看（语言）：`docs/design/node-graph-contract.md` §1 —— 同一张节点清单承载不同语言。
//   * 竖着看（后端）：§6 —— 后端只回答五问，**同一张图在每个后端上的可观察行为必须一致**。
// 加一门语言或加一个后端，矩阵自动多一行/一列 —— 这就是"自动覆盖全部后端"的确切含义。
//
//   node tests/graph/run.js            全跑
//   node tests/graph/run.js --sx chez  顺带把那门语言的图印成 sx（人看的）
//   node tests/graph/run.js --gaps     印每个后端接不住的节点清单

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { toSx } from '../../src/core/graph/graph.js';
import { backends, gaps } from '../../src/core/graph/contract.js';
import { chezToGraph } from '../../ext/chez/tograph.js';
import { luaToGraph } from '../../ext/lua/tograph.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;

/** 期望的输出 —— **一份，所有语言、所有后端共用**。这就是这一格的全部判据。 */
const EXPECT = ['15', '120', '7', 'ok'];

const CASES = [
  { name: 'chez', grammar: 'ext/chez/chez.grammar', file: 'ext/chez/examples/basics.ss', toGraph: chezToGraph },
  { name: 'lua', grammar: 'ext/lua/lua.grammar', file: 'ext/lua/examples/basics.lua', toGraph: luaToGraph },
];

const argv = process.argv.slice(2);
const showSx = argv.includes('--sx');
const showGaps = argv.includes('--gaps');
const only = argv.filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;

if (showGaps) {
  for (const b of backends()) {
    const g = gaps(b.name);
    process.stdout.write(`${b.name}: ${g.length === 0 ? '没有缺口（13 格全接得住）' : `${g.length} 格接不住`}\n`);
    for (const x of g) process.stdout.write(`    ${x.op} —— ${x.why}\n`);
  }
  process.stdout.write('\n');
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
    if (showSx) process.stdout.write(`\n---- ${c.name} ----\n${toSx(g)}\n`);
  } catch (err) {
    process.stdout.write(`  FAIL graph/${c.name}（树 -> 图）: ${err.message}\n`);
    fail++;
    continue;
  }

  for (const b of backends()) {
    const label = `${c.name} × ${b.name}`;
    if (b.runnable === false) {
      // 只序列化的后端（sx）只对"出得来、且不空"负责 —— 它不承诺跑
      try {
        const art = b.lower(g);
        if (typeof art.text === 'string' && art.text.length > 0) {
          process.stdout.write(`  ok   ${label} [序列化 ${art.text.split('\n').length} 行]\n`); pass++;
        } else { process.stdout.write(`  FAIL ${label}: 序列化出来是空的\n`); fail++; }
      } catch (err) { process.stdout.write(`  FAIL ${label}: ${err.message}\n`); fail++; }
      continue;
    }
    try {
      const { out } = b.lower(g).run();
      const got = out.join(' / ');
      const want = EXPECT.join(' / ');
      if (got === want) { process.stdout.write(`  ok   ${label} [${got}]\n`); pass++; } else {
        process.stdout.write(`  FAIL ${label}\n       期望 ${want}\n       得到 ${got}\n`);
        fail++;
      }
    } catch (err) {
      process.stdout.write(`  FAIL ${label}: ${err.message}\n`);
      fail++;
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（语言 ${CASES.length} × 后端 ${backends().length}）\n`);
if (fail > 0) process.exit(1);
