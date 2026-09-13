// tests/lib/jnc-specs.js —— 说明符那一族的对账尺子：**三问**
//
//   甲 表 vs 位置：新读取器（只认洞名）与位置遍历（不看表）数出的词个数必须一样
//   乙 词表交叉验证：读出的每个词都该在 jancy 的词汇表里（`src/lang/jnc/syntax.js`
//      —— 那是从 jancy 的 `.llk` 抄来的，**独立来源**）。出现表外的词 = 我抄漏了
//   丙 覆盖：词汇表里哪些词语料里没出现（那是语料的边界，不是错）
//
// 用法：node tests/lib/jnc-specs.js [文件数，默认 80] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { readSpecs, modWords } from '../../src/lang/jnc/specs.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import {
  STORAGE, ACCESS, MODS, TYPES,
} from '../../src/lang/jnc/syntax.js';

const EXTERNAL = '/Users/wurui/Documents/Lang/reference/jancy';
const CORPUS = existsSync(EXTERNAL) ? EXTERNAL : 'tests/jnc/cases';
const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 80);
const all = argv.includes('--all');

const VOCAB = new Set([
  ...Object.keys(STORAGE), ...Object.keys(ACCESS), ...Object.keys(MODS), ...Object.keys(TYPES),
]);

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

/** 不看表那一遍：顺着位置数 mods 链的长度。 */
function rawWords(node) {
  let n = 0;
  let cur = node;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    if (headOf(cur) !== 'mods-add') break;
    n += 1;
    cur = cur.items[1];
  }
  return n;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);
let all2 = 0;
let read = 0;
let bad = 0;
const seen = new Map();
const outside = new Map();

function visit(n) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
  if (headOf(n) === 'specs') {
    all2 += 1;
    const got = readSpecs(n);
    if (got === null) bad += 1;
    else {
      read += 1;
      const nm = named(n);
      const rawN = rawWords(nm.pre) + rawWords(nm.post);
      if (got.words.length !== rawN) bad += 1;
      for (const w of got.words) {
        seen.set(w, (seen.get(w) ?? 0) + 1);
        if (!VOCAB.has(w)) outside.set(w, (outside.get(w) ?? 0) + 1);
      }
    }
  }
  for (const it of n.items) visit(it);
}

for (const f of files) {
  const diags = new Diagnostics();
  try { visit(jncParse(tb, f, diags)); } catch { /* 解析不了的归语料尺子 */ }
}

console.log(`语料 ${files.length} 份　说明符 ${all2} 个　读出 ${read}`
  + `（${((read / Math.max(all2, 1)) * 100).toFixed(1)}%）　甲+乙 对不上 ${bad}`);
console.log(`词汇表 ${VOCAB.size} 个词；语料里见过 ${seen.size} 个`);
if (outside.size > 0) {
  console.log('\n乙 表外的词（我抄漏了 / 语法比词汇表宽）：');
  for (const [w, n] of [...outside].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${w}`);
}
const unseen = [...VOCAB].filter((w) => !seen.has(w));
console.log(`\n丙 词汇表里语料没出现的 ${unseen.length} 个`
  + `${unseen.length > 0 ? `：${(all ? unseen : unseen.slice(0, 14)).join(' ')}${!all && unseen.length > 14 ? ' …' : ''}` : ''}`);
process.exitCode = bad === 0 && outside.size === 0 ? 0 : 1;
