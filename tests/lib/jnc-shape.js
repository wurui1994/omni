// tests/lib/jnc-shape.js —— jancy 节点表的**形状对账**：表里声明的洞 vs 真树里的子项
//
// 为什么要这一把（吃过的账）：`src/lang/jnc/nodes.js` 里的洞名与洞数是我照语法**猜**的。
// 猜得对不对，得拿真树量 —— jancy 那边就吃过"两份手写的表迟早对不上"（ADR-0029 10.14）。
// 一量就抓出两格：`specs` 我写了 2 格洞，树里是 3 格；`dcl` 我写了 3 格，树里是 4 格。
//
// 三栏输出：
//   对得上   表里的洞数与树里见过的子项数一致
//   对不上   不一致（报"表说几格、树见过几格"，并印每一格位置上最常见的子项头名 —— 照它修表）
//   没声明   树里有、表里还没有（就是下一刀的清单）
//
// 用法：node tests/lib/jnc-shape.js [文件数，默认 80] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { jncLang } from '../../src/lang/jnc/nodes.js';
import { named } from '../../src/lang/jnc/adapt.js';

/* 语料：外面那份 jancy 有就用它（大、真实），没有就退到仓库自带的用例 ——
   这样这把尺子在任何一份 checkout 上都跑得起来，能当闸门用。 */
const EXTERNAL = '/Users/wurui/Documents/Lang/reference/jancy';
const CORPUS = existsSync(EXTERNAL) ? EXTERNAL : 'tests/jnc/cases';
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

const headOf = (n) => {
  if (n === null || typeof n !== 'object') return null;
  if (!Array.isArray(n.items)) return n.kind === undefined ? null : `·${n.kind}`;
  const h = n.items[0];
  return h !== null && h !== undefined && typeof h.value === 'string' ? h.value : (n.rule ?? '?');
};

/** 每个头名：见过哪些 arity、每个位置上的子项头名分布。 */
const shape = new Map();
/* 顺带直接量一遍 `named()`：形状对得上是"每个名字的 arity 都落在区间里"，
   而下游真正用的是 `named()` 认不认这**一个**节点 —— 两者该同时是满分，分头量才看得出。 */
let nodes = 0;
let nameable = 0;

function visit(n) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
  const name = headOf(n);
  nodes += 1;
  if (named(n) !== null) nameable += 1;
  if (typeof name === 'string') {
    let rec = shape.get(name);
    if (rec === undefined) {
      rec = { arity: new Map(), slots: [] };
      shape.set(name, rec);
    }
    const k = n.items.length - 1;
    rec.arity.set(k, (rec.arity.get(k) ?? 0) + 1);
    for (let i = 1; i < n.items.length; i += 1) {
      if (rec.slots[i - 1] === undefined) rec.slots[i - 1] = new Map();
      const c = headOf(n.items[i]) ?? '·空';
      rec.slots[i - 1].set(c, (rec.slots[i - 1].get(c) ?? 0) + 1);
    }
  }
  for (const it of n.items) visit(it);
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);
let ok = 0;
for (const f of files) {
  const diags = new Diagnostics();
  try { visit(jncParse(tb, f, diags)); ok += 1; } catch { /* 解析不了的归语料尺子管 */ }
}

/**
 * 表里声明的洞。**判据是区间**：带 `?` 的洞可缺，所以树里的子项数该落在
 * [必填格数, 全部格数] 里。先前判"唯一 arity 等于洞数"，那把 GLR 里最常见的两种形状
 * 都判成了错：一是"空基例 + `-add` 递归"的列表（`mods` 空、`mods-add` 两格），
 * 二是同一个头名有几条产生式（`dcl` 3/4 格）。
 */
const declared = new Map();
for (const n of jncLang.nodes) {
  if (n.holes === undefined) continue;
  const names = Object.keys(n.holes);
  const need = names.filter((k) => !String(n.holes[k]).includes('?')).length;
  declared.set(n.name, { names, need, all: names.length });
}

const top = (m, k = 2) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k)
  .map(([x, c]) => `${x}×${c}`).join(' ');

const good = [];
const bad = [];
const missing = [];
for (const [name, rec] of [...shape].sort((a, b) => {
  const sum = (r) => [...r[1].arity.values()].reduce((x, y) => x + y, 0);
  return sum(b) - sum(a);
})) {
  const holes = declared.get(name);
  const seen = [...rec.arity.keys()].sort((a, b) => a - b);
  if (holes === undefined) { missing.push([name, rec, seen]); continue; }
  if (seen.every((k) => k >= holes.need && k <= holes.all)) good.push(name);
  else bad.push([name, rec, seen, holes]);
}

const cnt = (rec) => [...rec.arity.values()].reduce((x, y) => x + y, 0);
console.log(`语料 ${files.length} 份（解析成 ${ok}）　树里 ${shape.size} 个名字`);
console.log(`形状对得上 ${good.length}　对不上 ${bad.length}　树里有表里没声明 ${missing.length}`);
console.log(`named() 认得 ${nameable}/${nodes} 个节点`
  + `（${(nameable / Math.max(nodes, 1) * 100).toFixed(1)}%）`);

if (bad.length > 0) {
  console.log('\n对不上（照实测的形状修表）：');
  for (const [name, rec, seen, holes] of bad) {
    console.log(`  ${name}（${cnt(rec)} 处）表说 ${holes.need}~${holes.all} 格`
      + ` [${holes.names.join(' ')}]，树里见过 ${seen.join('/')} 格`);
    rec.slots.slice(0, 6).forEach((m, i) => console.log(`      第 ${i + 1} 格：${top(m)}`));
  }
}
if (missing.length > 0) {
  console.log('\n树里有、表里还没声明（下一刀的清单，按出现次数）：');
  for (const [name, rec, seen] of (all ? missing : missing.slice(0, 12))) {
    console.log(`  ${String(cnt(rec)).padStart(6)}  ${name}　子项 ${seen.join('/')} 格`
      + `${rec.slots[0] === undefined ? '' : `　第 1 格：${top(rec.slots[0], 1)}`}`);
  }
  if (!all && missing.length > 12) console.log(`  …… 还有 ${missing.length - 12} 个（--all 全印）`);
}
process.exitCode = bad.length === 0 ? 0 : 1;
