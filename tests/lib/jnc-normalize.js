// tests/lib/jnc-normalize.js —— 规整（GLR 树 → 引擎节点形状）的对账
//
// 问三件事，都是可被推翻的：
//   甲  **规整跑不跑得完**：`normalize()` 碰到表里没有的头名、或者形状与表对不上就当场炸。
//       语料一份都不许炸 —— 炸了就是节点表还差一格（那是 jnc-shape 那把尺子的活儿，
//       但这儿会先撞上，因为它是逐个节点问的）。
//   乙  **一格没丢**：GLR 树里的节点与记号总数，与规整之后的节点 + 记号 + 数组元素总数对得上。
//       拉平列表会把 `unit-add` 那一族的节点收掉，所以那一族单独数（`收掉的链节点`）。
//   丙  **`name` 都变成了名字叶子**：查名那一步靠它，漏一个就是下游查不着。
//
// 用法：node tests/lib/jnc-normalize.js [文件数，默认 80] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { normalize, JNC_LISTS } from '../../src/lang/jnc/normalize.js';
import { headOf } from '../../src/lang/jnc/adapt.js';
import { refDir } from './refsrc.js';

const EXTERNAL = refDir('jancy', 'JANCY');
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

const ADD_HEADS = new Set(Object.values(JNC_LISTS));

/** GLR 那边：每个头名出现几次（`items[0]` 那个记号是**头**，不算内容记号）。 */
function tallyTree(n, out) {
  if (n === null || n === undefined || typeof n !== 'object') return;
  if (!Array.isArray(n.items)) { out.set('·记号', (out.get('·记号') ?? 0) + 1); return; }
  const h = headOf(n) ?? '·无头';
  out.set(h, (out.get(h) ?? 0) + 1);
  for (let i = 1; i < n.items.length; i += 1) tallyTree(n.items[i], out);
}

/** 规整之后：每个 `kind` 出现几次（数组不是节点，只走进去）。 */
function tallyOut(v, out) {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) { for (const x of v) tallyOut(x, out); return; }
  if (typeof v !== 'object') return;
  const leaf = v.kind === 'tok' || v.kind === 'name';
  out.set(leaf && v.kind === 'tok' ? '·记号' : v.kind, (out.get(leaf && v.kind === 'tok' ? '·记号' : v.kind) ?? 0) + 1);
  for (const key of Object.keys(v)) {
    if (key === 'kind' || key === 'line') continue;
    /* `value` 只在叶子上是"自己的文本"；别的节点真有叫 `value` 的洞
       （`cast.value` / `init.value` / `enum-item.value`…）—— 先前一刀切跳过它，
       于是那些子树整片没数着，尺子自己报出 20 种"丢格"。**尺子错，不是规整错。** */
    if (leaf && key === 'value') continue;
    tallyOut(v[key], out);
  }
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let parsed = 0;
const inn = new Map();
const out = new Map();
const boom = [];

for (const f of files) {
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  parsed += 1;
  let got;
  try { got = normalize(tree); } catch (err) {
    boom.push([f.slice(CORPUS.length + 1), err.message]);
    continue;
  }
  tallyTree(tree, inn);
  tallyOut(got, out);
}

/* 逐个头名对：GLR 里有几处、规整后有几处。
   两处**该有的差**（不是丢，是规整本身要做的事，所以写死在这儿当期望）：
     - 链节点（`unit-add` 那一族）拉平成数组，节点自己没了 → 规整后 0 处；
     - `name` 裹的那个记号变成叶子自己的 `value` → 记号总数少掉 name 的处数。 */
const heads = [...new Set([...inn.keys(), ...out.keys()])].sort();
const names = inn.get('name') ?? 0;
const rows = [];
for (const h of heads) {
  const a = inn.get(h) ?? 0;
  const b = out.get(h) ?? 0;
  let want = a;
  if (ADD_HEADS.has(h) || JNC_LISTS[h] !== undefined) want = 0;      // 拉平收掉
  if (h === '·记号') want = a - names;                                // name 裹的那格并进叶子
  if (b !== want) rows.push([h, a, b, want]);
}

console.log(`语料 ${parsed}/${files.length} 份　GLR 里 ${heads.length} 种头名`);
console.log(`甲 炸掉的文件 ${boom.length}　乙 逐头名对不上 ${rows.length} 种`
  + `　丙 name → 名字叶子 ${out.get('name') ?? 0}/${names}`);

if (boom.length > 0) {
  console.log('\n炸掉的（节点表还差一格）：');
  for (const [f, why] of (all ? boom : boom.slice(0, 10))) console.log(`  ${f}　${why}`);
  if (!all && boom.length > 10) console.log(`  …… 还有 ${boom.length - 10} 份（--all 全印）`);
}
if (rows.length > 0) {
  console.log('\n对不上（规整把这些格丢了或多造了）：');
  for (const [h, a, b, want] of rows.sort((x, y) => Math.abs(y[3] - y[2]) - Math.abs(x[3] - x[2]))
    .slice(0, all ? 999 : 20)) {
    console.log(`  ${h}　GLR ${a} 处，规整后 ${b} 处（该有 ${want}，差 ${b - want}）`);
  }
}
process.exitCode = boom.length === 0 && rows.length === 0 ? 0 : 1;
