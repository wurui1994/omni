// tests/lib/jnc-declare.js —— 新读取器的对账尺子：**同一件事算两遍，必须一样**
//
// 新读取器（`src/lang/jnc/declare.js`）只认洞的名字；这把尺子拿**位置遍历**再算一遍
// （raw walk：不看表，只顺着 `items`），两边对不上就说明命名那一层错了。
// 这是"并跑对账"的第一格 —— 新旧共存、逐格核对，不必大爆炸（ADR-0030 第 3 节）。
//
// 用法：node tests/lib/jnc-declare.js [文件数，默认 80]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { readDcl } from '../../src/lang/jnc/declare.js';
import { headOf } from '../../src/lang/jnc/adapt.js';
import { refDir } from './refsrc.js';

const EXTERNAL = refDir('jancy', 'JANCY');
const CORPUS = existsSync(EXTERNAL) ? EXTERNAL : 'tests/jnc/cases';
const limit = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 80);

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

/** 不看表的那一遍：顺着位置数指针与后缀。 */
function rawCount(node, addHead) {
  let n = 0;
  let cur = node;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    if (headOf(cur) !== addHead) break;
    n += 1;
    cur = cur.items[1];
  }
  return n;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);
let all = 0;
let read = 0;
const piles = new Map();
const pile = (k, x) => {
  if (!piles.has(k)) piles.set(k, []);
  piles.get(k).push(x);
};

function visit(n, file) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
  if (headOf(n) === 'dcl') {
    all += 1;
    const got = readDcl(n);
    if (got === null) pile('读不出来（形状不认得）', file);
    else {
      read += 1;
      const rawPtrs = rawCount(n.items[1], 'ptrs-add');
      const rawSuf = rawCount(n.items[3], 'suffixes-add');
      if (got.ptrs !== rawPtrs) pile(`指针层数对不上（表 ${got.ptrs} vs 位置 ${rawPtrs}）`, file);
      if (got.suffixes.length !== rawSuf) {
        pile(`后缀个数对不上（表 ${got.suffixes.length} vs 位置 ${rawSuf}）`, file);
      }
      if (got.name === null && headOf(n.items[2]) === 'name') pile('名字读不出来', file);
    }
  }
  for (const it of n.items) visit(it, file);
}

for (const f of files) {
  const diags = new Diagnostics();
  try { visit(jncParse(tb, f, diags), f.split('/').pop()); } catch { /* 解析不了的归语料尺子 */ }
}

const bad = [...piles.values()].reduce((a, v) => a + v.length, 0);
console.log(`语料 ${files.length} 份　声明符 ${all} 个　新读取器读出 ${read} 个`
  + `（${((read / Math.max(all, 1)) * 100).toFixed(1)}%）　对不上 ${bad}`);
for (const [k, v] of [...piles].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(v.length).padStart(5)}  ${k}`);
  console.log(`         ${[...new Set(v)].slice(0, 3).join('  ')}`);
}
process.exitCode = bad === 0 && read === all ? 0 : 1;
