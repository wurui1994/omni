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
//   node tests/graph/run.js --machines 印每格节点的**提供者名单**（G5 那条判据）
//
// **十门语言里缺 cpp，理由量过**：拿同样这份例子（`int sumto(int n) { … }`，7 行）
// 去过 `ext/cpp/cpp.grammar`，报的是 "too many concurrent parses" —— 连这么短的程序
// 都进不来。根因不在这一批节点，在 `cpp.grammar` 文件头记的那两条**机制欠账**：
// 判不了"声明还是表达式"、判不了 `<`/`>`，两条都要驱动器能回问一句"这个名字登记成
// 类型了吗"（`docs/design/node-graph-contract.md` 附录 A.5 第 3 笔账）。
// 那一格补上之前 cpp 不进这张矩阵 —— 硬塞一份"刚好能过的 C++ 子集"是自欺。

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { toSx } from '../../src/core/graph/graph.js';
import { backends, gaps } from '../../src/core/graph/contract.js';
import { chezToGraph } from '../../ext/chez/tograph.js';
import { luaToGraph } from '../../ext/lua/tograph.js';
import { goToGraph } from '../../ext/go/tograph.js';
import { sbclToGraph } from '../../ext/sbcl/tograph.js';
import { vlangToGraph } from '../../ext/vlang/tograph.js';
import { awkToGraph } from '../../ext/awk/tograph.js';
import { fbToGraph } from '../../ext/freebasic/tograph.js';
import { mojoToGraph } from '../../ext/mojo/tograph.js';
import { nimToGraph } from '../../ext/nim/tograph.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;

/**
 * 期望的输出。**一个例子家族一份**，家族里所有语言、所有后端共用 ——
 * 这就是这一格的全部判据。
 *   basics：第一批 11 格节点（decl / func / 控制流 / 循环 / print）
 *   multi ：多值那两格（values / pick）+ arity 契约（列表里只有最后一格展开）
 */
const BASICS = ['15', '120', '7', 'ok'];
const MULTI = ['3', '7', '1 2'];
/** defer：scope-exit 那一格 —— 逆序 + 早退也跑（八个提供者共用同一格节点） */
const DEFER = ['in', 'b', 'a', 'out'];
/** record：record-new / field-get / field-set 那三格 —— **与类型无关**（lua 的表没有类型） */
const RECORD = ['1', '5', '6'];

const CASES = [
  { name: 'chez', grammar: 'ext/chez/chez.grammar', file: 'ext/chez/examples/basics.ss', toGraph: chezToGraph, expect: BASICS },
  { name: 'lua', grammar: 'ext/lua/lua.grammar', file: 'ext/lua/examples/basics.lua', toGraph: luaToGraph, expect: BASICS },
  { name: 'go', grammar: 'ext/go/go.grammar', file: 'ext/go/examples/basics.go', toGraph: goToGraph, expect: BASICS },
  { name: 'sbcl', grammar: 'ext/sbcl/sbcl.grammar', file: 'ext/sbcl/examples/basics.lisp', toGraph: sbclToGraph, expect: BASICS },
  { name: 'vlang', grammar: 'ext/vlang/vlang.grammar', file: 'ext/vlang/examples/basics.v', toGraph: vlangToGraph, expect: BASICS },
  { name: 'awk', grammar: 'ext/awk/awk.grammar', file: 'ext/awk/examples/basics.awk', toGraph: awkToGraph, expect: BASICS },
  { name: 'freebasic', grammar: 'ext/freebasic/freebasic.grammar', file: 'ext/freebasic/examples/basics.bas', toGraph: fbToGraph, expect: BASICS },
  { name: 'mojo', grammar: 'ext/mojo/mojo.grammar', file: 'ext/mojo/examples/basics.mojo', toGraph: mojoToGraph, expect: BASICS },
  { name: 'nim', grammar: 'ext/nim/nim.grammar', file: 'ext/nim/examples/basics.nim', toGraph: nimToGraph, expect: BASICS },
  // ---- 第二个家族：多值 ----
  { name: 'lua+multi', grammar: 'ext/lua/lua.grammar', file: 'ext/lua/examples/multi.lua', toGraph: luaToGraph, expect: MULTI },
  { name: 'go+multi', grammar: 'ext/go/go.grammar', file: 'ext/go/examples/multi.go', toGraph: goToGraph, expect: MULTI },
  // ---- 第三个家族：作用域出口（go 的 defer 与 CL 的 unwind-protect 同一格节点）----
  { name: 'go+defer', grammar: 'ext/go/go.grammar', file: 'ext/go/examples/defer.go', toGraph: goToGraph, expect: DEFER },
  { name: 'sbcl+defer', grammar: 'ext/sbcl/sbcl.grammar', file: 'ext/sbcl/examples/defer.lisp', toGraph: sbclToGraph, expect: DEFER },
  { name: 'vlang+defer', grammar: 'ext/vlang/vlang.grammar', file: 'ext/vlang/examples/defer.v', toGraph: vlangToGraph, expect: DEFER },
  { name: 'nim+defer', grammar: 'ext/nim/nim.grammar', file: 'ext/nim/examples/defer.nim', toGraph: nimToGraph, expect: DEFER },
  // ---- 第四个家族：记录（四门语言四种字面量记号，落同一格 record-new）----
  { name: 'go+record', grammar: 'ext/go/go.grammar', file: 'ext/go/examples/record.go', toGraph: goToGraph, expect: RECORD },
  { name: 'lua+record', grammar: 'ext/lua/lua.grammar', file: 'ext/lua/examples/record.lua', toGraph: luaToGraph, expect: RECORD },
  { name: 'vlang+record', grammar: 'ext/vlang/vlang.grammar', file: 'ext/vlang/examples/record.v', toGraph: vlangToGraph, expect: RECORD },
  { name: 'nim+record', grammar: 'ext/nim/nim.grammar', file: 'ext/nim/examples/record.nim', toGraph: nimToGraph, expect: RECORD },
];

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

if (showGaps) {
  for (const b of backends()) {
    const g = gaps(b.name);
    process.stdout.write(`${b.name}: ${g.length === 0 ? '没有缺口（全接得住）' : `${g.length} 格接不住`}\n`);
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
    countOps(g, c.name.split('+')[0]);
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
      const want = c.expect.join(' / ');
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

if (showMachines) {
  // G5：一格节点的提供者名单。**只有一家的不算机器**（ADR-0033 §3.7 / §5 同一条纪律）。
  process.stdout.write('\n每格节点的提供者名单（数出来的）：\n');
  const rows = [...providers.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [op, langs] of rows) {
    const mark = langs.size >= 4 ? '机器' : (langs.size >= 2 ? '能力' : '一家');
    process.stdout.write(`  ${String(langs.size).padStart(2)} ${mark}  ${op.padEnd(11)}${[...langs].sort().join(' ')}\n`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（例子 ${CASES.length} × 后端 ${backends().length}）\n`);
if (fail > 0) process.exit(1);
