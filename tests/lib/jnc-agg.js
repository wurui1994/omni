// tests/lib/jnc-agg.js —— 聚合体读取器的对账
//
// 三问：
//   甲  每个 `agg` 读不读得出来（覆盖率）
//   乙  成员条数**两遍算**：一遍走读取器（洞名），一遍按位置数（体里每条声明的声明符个数
//       + 嵌套类型 / friend 各一格）。对不上就是读取器漏了一族。
//   丙  形状与访问的分布 —— 那是重写降级时"要分派几族"的清单。
//
// 用法：node tests/lib/jnc-agg.js [文件数，默认 80] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf } from '../../src/lang/jnc/adapt.js';
import { readAgg } from '../../src/lang/jnc/agg.js';

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

/** 位置法：一条链（`X` 空基例 + `X-add` 两格）里的每一项。 */
function chainPos(node, addHead, oneAt = 2, listAt = 1) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    if (headOf(cur) !== addHead) break;
    out.unshift(cur.items[oneAt]);
    cur = cur.items[listAt];
  }
  return out;
}

/** 位置法：这条体内声明里有几格成员。 */
function countPos(it) {
  const h = headOf(it);
  if (h === 'attributed') return countPos(it.items[2]);
  if (h === 'fn-def' || h === 'fn-proto') return 1;
  if (h === 'type-decl' || h === 'friend') return 1;
  if (h === 'var-decl' || h === 'typedef') {
    const dcls = it.items[2];
    if (dcls === null || dcls === undefined || !Array.isArray(dcls.items)) return 0;
    const hd = headOf(dcls);
    if (hd === 'dcls') return 1;
    if (hd === 'dcls-add') return chainPos(dcls, 'dcls-add').length + 1;   // 链 + 基例那一格
    return 1;
  }
  return 0;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let aggs = 0;
let readOk = 0;
let bad = 0;
const shapes = new Map();
const access = new Map();
const words = new Map();
const badWhy = [];

function visit(n, file) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
  if (headOf(n) === 'agg') {
    aggs += 1;
    const a = readAgg(n);
    if (a !== null) {
      readOk += 1;
      words.set(a.word ?? '?', (words.get(a.word ?? '?') ?? 0) + 1);
      for (const m of a.members) {
        shapes.set(m.shape, (shapes.get(m.shape) ?? 0) + 1);
        access.set(m.access, (access.get(m.access) ?? 0) + 1);
      }
      /* 第二遍：按位置数。`agg` 的第 4 格是体（`(agg word name bases body)`），
         但 bases 可缺 —— 所以体是**最后一格**。 */
      const body = n.items[n.items.length - 1];
      let want = 0;
      for (const it of chainPos(body, 'unit-add')) want += countPos(it);
      if (want !== a.members.length) {
        bad += 1;
        if (badWhy.length < 12) {
          badWhy.push(`${file}　读取器 ${a.members.length} 格、位置法 ${want} 格`
            + `（${a.word ?? '?'}）`);
        }
      }
    }
  }
  for (const it of n.items) visit(it, file);
}

for (const f of files) {
  try { visit(jncParse(tb, f, new Diagnostics()), f.slice(CORPUS.length + 1)); } catch { /* 归语料尺子 */ }
}

console.log(`语料 ${files.length} 份　聚合体 ${aggs} 个　读出 ${readOk}`
  + `（${(readOk / Math.max(aggs, 1) * 100).toFixed(1)}%）　成员条数两遍对不上 ${bad}`);
console.log(`种类：${[...words].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('  ')}`);
console.log(`成员形状：${[...shapes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('  ')}`);
console.log(`访问：${[...access].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('  ')}`);
if (badWhy.length > 0) {
  console.log('\n对不上（读取器漏了一族，照实测的补）：');
  for (const w of (all ? badWhy : badWhy.slice(0, 8))) console.log(`  ${w}`);
}
process.exitCode = bad === 0 && readOk === aggs ? 0 : 1;
