// tests/lib/jnc-heads.js —— jancy 规则化的**清单尺子**：树里到底有哪些节点、各占多少
//
// 为什么先量这个（ADR-0030 第 3 节）：`frontend-jnc/lower.js` 是 15,497 行的单体，
// 要按规则化重写，第一件事是把"节点表该有哪几格"**量出来**而不是猜。
// jancy 走 GLR —— 而 GLR 的语法文件里每条产生式的动作头**就是节点名**
// （`(-> ("import" LITERAL) (import $2))` 里那个 `import`），所以树本来就是"带名字的节点"，
// 与读表那条腿的节点表是同一种东西。这就是"GLR 与规则化相容"的实证。
//
// 这把尺子答三问：
//   1. 语料里真出现过哪些节点名（按出现次数排 —— 重写就按这个顺序推）
//   2. 一共多少格（节点表的规模）
//   3. 新节点表（`src/lang/jnc/nodes.js`，还没写）覆盖了几格 —— 进度就是这个数
//
// 用法：node tests/lib/jnc-heads.js [文件数，默认 80] [--all 印全部]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';

const CORPUS = '/Users/wurui/Documents/Lang/reference/jancy';
const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 80);
const all = argv.includes('--all');

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const e of names) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.jnc')) out.push(p);
  }
  return out;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);
if (files.length === 0) {
  console.log(`语料目录里没找到 .jnc（试的是 ${CORPUS}）`);
  process.exit(0);
}

/** 树里每个节点的"头"：`items[0]` 是个记号时它的 value 就是节点名。 */
function heads(node, out) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node.items)) {
    const h = node.items[0];
    const name = h !== null && h !== undefined && typeof h.value === 'string' ? h.value : node.rule;
    if (typeof name === 'string') out.set(name, (out.get(name) ?? 0) + 1);
    for (const it of node.items) heads(it, out);
  }
  return out;
}

const tally = new Map();
let ok = 0;
let bad = 0;
for (const f of files) {
  const diags = new Diagnostics();
  try {
    heads(jncParse(tb, f, diags), tally);
    ok += 1;
  } catch {
    bad += 1;                    // 解析不了的先不算（那是语料尺子的事）
  }
}

const rows = [...tally].sort((a, b) => b[1] - a[1]);
console.log(`语料 ${files.length} 份（解析成 ${ok}、跳过 ${bad}）　树里不同的节点名 ${rows.length} 个`
  + `　节点总数 ${[...tally.values()].reduce((a, b) => a + b, 0)}`);
console.log('\n按出现次数排（重写就按这个顺序推）：');
for (const [name, n] of all ? rows : rows.slice(0, 60)) {
  console.log(`  ${String(n).padStart(6)}  ${name}`);
}
if (!all && rows.length > 60) console.log(`  …… 还有 ${rows.length - 60} 个（--all 全印）`);
