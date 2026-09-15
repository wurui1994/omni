// tests/graph/delete.js —— **可删除测试**：删掉一格特性，剩下的程序照旧跑
//
// 这一条是 `target.md` 里问得最重的那一句的答案：
//
//   > 怎么保证我删了一个重要特性后，源码不需要到处改动？
//   > 比如我删了 class 特性，影响了一大批特性，你能确保符合剩下特性的程序正常运行吗？
//   > …不做可删除测试，你怎么保证。
//
// 在这一层，"一格特性"的载体就是**一格节点**（`src/core/graph/nodes.js` 的五栏声明）。
// 于是"删掉一格特性"是一处改动：把它从 `NODES` 里拿掉。判据三条，全是机械的：
//
//   1. **不用它的例子必须照旧全绿** —— 这就是"源码不需要到处改动"的可执行版本。
//   2. **用了它的例子必须报"没有这一格节点"**（`no such node: X`），而且必须报在
//      建图那一步。报别的错（unbound name / undefined / 跑出错答案）一律算 **FAIL** ——
//      那说明删这一格会让**别处**崩，级联算漏了。
//   3. 每格节点的**级联半径**（影响几份例子）是**数出来的**，不是手写的文档。
//
// 为什么这条判据有意义：它检的是**依赖的方向**。ADR-0033 把节点之间的关系限成
// "端口 + 效应"，没有"节点 A 认识节点 B"这种硬连接 —— 所以删一格节点，别的节点
// 不该有任何一行要改。这一条跑绿，那句话才算兑现；跑红，就是架构漏了。
//
//   node tests/graph/delete.js            全跑（末尾印级联半径表）
//   node tests/graph/delete.js loop-exit  只删那一格

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { NODES } from '../../src/core/graph/nodes.js';
import { evalGraph } from '../../src/core/graph/eval.js';
import { CASES, HAND } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;

/** 先把树全解析出来（**只解析一遍**）—— 后面每删一格节点，只重跑"树 -> 图 -> eval"。 */
const trees = [];
for (const c of CASES) {
  const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
  const text = readText(`${ROOT}${c.file}`);
  const diags = new Diagnostics();
  const toks = lexText(tb.grammar.lex, new SourceFile(c.file, text), diags);
  const tree = toks === null ? null : glrParse(tb, toks, diags);
  if (tree === null || diags.hasErrors()) {
    process.stdout.write(`  FAIL ${c.name}（解析）: ${diags.items[0]?.msg}\n`);
    fail++;
    continue;
  }
  trees.push({ ...c, tree });
}

/** 一份例子在"当前这套节点"下的结果：绿 / 缺哪一格 / 崩在别处。 */
function tryCase(c) {
  let g = null;
  try {
    g = c.tree === undefined ? c.graph() : c.toGraph(c.tree);
  } catch (err) {
    return classify(err);
  }
  try {
    const { out } = evalGraph(g);
    const got = out.join(' / ');
    const want = c.expect.join(' / ');
    return got === want ? { kind: 'ok' } : { kind: 'broke', why: `跑出别的答案：${got}` };
  } catch (err) {
    return classify(err);
  }
}

/**
 * 一个错误说的是"缺了我删掉的那一格"，还是"崩在别处"。
 * 两种"缺"都认：缺节点（`no such node: X`）与缺附属（`node X has no attr "Y"`）——
 * 后者是 G1 那条边完整检查顺手给的，不用新机制。
 */
function classify(err) {
  const n = /^no such node: (.+)$/.exec(err.message);
  if (n !== null) return { kind: 'needs', what: n[1] };
  const a = /^node (\S+) has no attr "([^"]+)"/.exec(err.message);
  if (a !== null) return { kind: 'needs', what: `${a[1]}.${a[2]}` };
  return { kind: 'broke', why: err.message };
}

const all = [...trees, ...HAND];
const ops = [...NODES.keys()].filter((op) => only.length === 0 || only.includes(op));
const radius = [];

/**
 * 删一格东西，跑一遍全部例子。`what` 是"删掉的那一格"的名字 ——
 * 例子只许两种反应：照旧全绿，或者说"缺 what"。第三种反应就是级联算漏了。
 */
function deleteAndRun(label, what, remove, restore) {
  remove();
  const needs = [];
  const broke = [];
  let green = 0;
  for (const c of all) {
    const r = tryCase(c);
    if (r.kind === 'ok') { green++; continue; }
    if (r.kind === 'needs' && r.what === what) { needs.push(c.name); continue; }
    // 缺的是别的东西 = 也算"崩在别处"：删 A 不该让例子去要 B
    broke.push(`${c.name}（${r.kind === 'needs' ? `改去要 ${r.what}` : r.why}）`);
  }
  restore();

  if (broke.length === 0) {
    process.stdout.write(`  ok   删 ${label.padEnd(18)}`
      + `${needs.length} 份例子要它，剩下 ${green} 份照旧全绿\n`);
    pass++;
  } else {
    process.stdout.write(`  FAIL 删 ${label}：${broke.length} 份例子崩在别处（级联算漏了）\n`);
    for (const b of broke.slice(0, 4)) process.stdout.write(`       ${b}\n`);
    fail++;
  }
  radius.push({ what: label, needs: needs.length, green });
}

// ---- 第一轮：删**节点**（骨架那一层）------------------------------------------
for (const op of ops) {
  const decl = NODES.get(op);
  deleteAndRun(op, op, () => NODES.delete(op), () => NODES.set(op, decl));
}

// ---- 第二轮：删**附属**（挂在节点上那一层）------------------------------------
//
// 附属的删除不用新机制：`node()` 建节点时对不上声明就报 `has no attr` —— 那是 G1
// 那条"边完整"检查顺手给的。半径小的附属（`keepMulti` 只有多值那两份例子要它）
// 正是"附属可删"的证据；半径大的（`bind.name`）说明它其实是骨架的一部分。
for (const op of ops) {
  const decl = NODES.get(op);
  const orig = [...decl.attrs];
  for (const attr of orig) {
    deleteAndRun(`${op}.${attr}`, `${op}.${attr}`,
      () => { decl.attrs = orig.filter((a) => a !== attr); },
      () => { decl.attrs = orig; });
  }
}

// 级联半径表：**数出来的**。半径大的那几格就是"这台机器的骨架"，
// 半径为 0 的那几格是"想删就能删"的 —— 后者才是"原子化"真正的样子。
process.stdout.write('\n级联半径（删了它，几份例子要它）：\n');
for (const r of [...radius].sort((a, b) => b.needs - a.needs)) {
  const bar = '#'.repeat(Math.min(r.needs, 42));
  process.stdout.write(`  ${r.what.padEnd(18)}${String(r.needs).padStart(2)}/${r.needs + r.green} ${bar}\n`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `（删了 ${radius.length} 样：节点 ${ops.length} 格 + 附属 ${radius.length - ops.length} 格，`
  + `每样跑 ${all.length} 份例子）\n`);
if (fail > 0) process.exit(1);
