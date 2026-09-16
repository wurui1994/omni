#!/usr/bin/env node
// tests/graph/order.js —— **G4：次序与临时量命名逐字节相同，与加载顺序无关**
//
// ADR-0033 的 G4 原话是：「同一张图算出来的次序与临时量命名**逐字节相同**，与特性加载顺序
// 无关」。矩阵那条轴一直**间接**管着它（十门语言同一份期望输出），可"间接"漏得掉三件事：
//
//   1. **搭两遍**：结构一样、`id` 不同的两张图，落出来的文本必须逐字节相同 ——
//      节点 `id` 是个全局计数器（`graph.js` 的 `seq`），临时量名字要是沾上它，
//      两次编译同一份源码就会给出不同的产物（缓存、快照、diff 全部作废）。
//   2. **降两遍**：同一张图连降两次必须一样 —— 后端里的计数器要是没每次重置，第二次就偏。
//   3. **换加载顺序**：把节点声明表（`NODES`）与内建表（`PRIMS`）的**插入顺序倒过来**
//      再降一遍，仍要逐字节相同。这一条正是 G4 那句"与特性加载顺序无关"的字面意思：
//      节点是一批批加进来的，谁先谁后不许影响产物。
//
// 语料用手搭的那几张图（`cases.js` 的 `HAND`）—— 它们是 thunk，天生能"搭两遍"，
// 而且不必建语法表。落文本的三条腿都验：js / wat / sx。
//
//   node tests/graph/order.js
//   node tests/graph/order.js exit-order

import { backends, Gap } from '../../src/core/graph/contract.js';
import { NODES } from '../../src/core/graph/nodes.js';
import { PRIMS } from '../../src/core/graph/prims.js';
import { HAND } from './cases.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n${why}\n`); };

/** 印第一处不同 —— 整份产物贴出来没人读（与 tests/glr/run.js 那条一样的做法）。 */
function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    return `       第 ${i + 1} 行\n       甲: ${JSON.stringify(x[i] ?? '<eof>')}\n       乙: ${JSON.stringify(y[i] ?? '<eof>')}`;
  }
  return '       只差在末尾那几个字节';
}

/** 把一张 Map 的插入顺序倒过来（Map 按插入序迭代 —— 这就是"换加载顺序"）。 */
function flip(m) {
  const items = [...m.entries()].reverse();
  m.clear();
  for (const [k, v] of items) m.set(k, v);
}

/** 落一份文本；接不住就回 `{gap}`（缺口不是失败）。 */
function textOf(back, g) {
  try {
    return { text: back.lower(g).text };
  } catch (err) {
    if (err instanceof Gap) return { gap: err.message };
    return { bad: `${err.message}` };
  }
}

const TEXTY = backends().filter((b) => b.name !== 'interp');

for (const c of HAND) {
  if (only.length > 0 && !only.some((x) => c.name.includes(x))) continue;
  for (const back of TEXTY) {
    const label = `${c.name} × ${back.name}`;
    // ---- 1) 搭两遍（两张结构相同、id 不同的图）
    const a = textOf(back, c.graph());
    const b = textOf(back, c.graph());
    if (a.gap !== undefined || b.gap !== undefined) {
      process.stdout.write(`  skip ${label}：${a.gap ?? b.gap}\n`);
      continue;
    }
    if (a.bad !== undefined || b.bad !== undefined) {
      no(label, `       ${a.bad ?? b.bad}`);
      continue;
    }
    if (a.text !== b.text) {
      no(`${label}〔搭两遍〕`, `       同一张图搭两遍，产物不一样（临时量名字沾上了全局 id？）\n${firstDiff(a.text, b.text)}`);
      continue;
    }
    // ---- 2) 同一张图降两遍
    const g = c.graph();
    const c1 = textOf(back, g);
    const c2 = textOf(back, g);
    if (c1.text !== c2.text) {
      no(`${label}〔降两遍〕`, `       同一张图连降两次，产物不一样（后端里的计数器没重置？）\n${firstDiff(c1.text, c2.text)}`);
      continue;
    }
    // ---- 3) 换加载顺序（声明表与内建表都倒过来）
    flip(NODES);
    flip(PRIMS);
    const d = textOf(back, c.graph());
    flip(NODES);
    flip(PRIMS);
    if (d.bad !== undefined) {
      no(`${label}〔换加载顺序〕`, `       ${d.bad}`);
      continue;
    }
    if (d.gap !== undefined) {
      no(`${label}〔换加载顺序〕`, `       倒过来之后反倒报缺口：${d.gap}`);
      continue;
    }
    if (d.text !== a.text) {
      no(`${label}〔换加载顺序〕`, `       声明表顺序一换，产物就变了 —— G4 那句"与加载顺序无关"不成立\n${firstDiff(a.text, d.text)}`);
      continue;
    }
    ok(`${label} [搭两遍 · 降两遍 · 声明表倒序，三遍逐字节相同（${a.text.length} 字节）]`);
  }
}

// ---- 4) 那两张表倒回来了没有（这条轴自己**改过全局状态**，得当场证明它收拾干净了）
{
  const nodesOk = [...NODES.keys()][0] === 'const';
  const primsOk = [...PRIMS.keys()].length > 0;
  if (!nodesOk || !primsOk) {
    no('收拾干净〔声明表倒回来了〕', `       NODES 第一格现在是 ${[...NODES.keys()][0]}（该是 const）`);
  } else ok('收拾干净〔声明表倒回来了 —— 这条轴动过全局状态，得自己证明〕');
}

process.stdout.write(`\n${pass} passed, ${fail} failed（G4：次序与临时量命名与加载顺序无关）\n`);
if (fail > 0) process.exit(1);
