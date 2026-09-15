// tests/lib/jnc-types.js —— 类型读取器的对账：**同一件事算两遍**
//
// `src/lang/jnc/types.js` 把"一格声明的类型"从两张表拼出来（说明符 + 声明符）。对不对，
// 用与 `jnc-declare` / `jnc-specs` 同一条路子验：一遍走**洞名**（`readDeclType`），
// 一遍走**位置索引**（GLR 原树 `items[1]` / `items[3]` 那样数），两遍对不上就是表错。
//
// 三栏：
//   甲  读得出多少（覆盖率）
//   乙  两遍的 `*` 层数与后缀链**逐格**对不对
//   丙  形状分布（data / fn / array / prop / event / fnptr / bitfield）—— 那是降级要分派的依据
//
// 用法：node tests/lib/jnc-types.js [文件数，默认 80] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { readDeclType, typeText } from '../../src/lang/jnc/types.js';
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

/** 第二遍：**按位置**数 `*` 的层数（`(dcl ptrs core suffixes ctor)` 的第 1 格是 ptrs 链）。 */
function ptrsByPos(dcl) {
  const chain = dcl?.items?.[1];
  let n = 0;
  let cur = chain;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    if (headOf(cur) !== 'ptrs-add') break;
    n += 1;
    cur = cur.items[1];                             // 左递归：`(ptrs-add 前面那串 这一格)`
  }
  return n;
}

/** 第二遍：**按位置**读后缀链的头名（第 3 格）。 */
function suffixesByPos(dcl) {
  const out = [];
  let cur = dcl?.items?.[3];
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    if (headOf(cur) !== 'suffixes-add') break;
    out.unshift(headOf(cur.items[2]));
    cur = cur.items[1];
  }
  return out;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

let sites = 0;
let read = 0;
let bad = 0;
const shapes = new Map();
const badWhy = [];

/** 一条声明的 (specs, dcl) 对：`fn-def` / `fn-proto` / `formal` 一格，`var-decl` 一串。 */
function decls(n, out = []) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return out;
  const h = headOf(n);
  const nm = named(n);
  if (nm !== null && (h === 'fn-def' || h === 'fn-proto' || h === 'formal')) {
    out.push([nm.specs, nm.dcl]);
  } else if (nm !== null && (h === 'var-decl' || h === 'typedef')) {
    for (const d of chain(nm.dcls)) out.push([nm.specs, d]);
  }
  for (const it of n.items) decls(it, out);
  return out;
}

/** `dcls` / `dcls-add` 那一串（这儿也按位置走 —— 尺子的第二遍不许借读取器）。 */
function chain(node) {
  const out = [];
  let cur = node;
  while (cur !== null && cur !== undefined && Array.isArray(cur.items)) {
    const h = headOf(cur);
    if (h === 'dcls-add') { out.unshift(cur.items[2]); cur = cur.items[1]; continue; }
    if (h === 'dcls') { out.unshift(cur.items[1]); break; }
    out.unshift(cur);                               // 光一个 dcl / init
    break;
  }
  return out;
}

/** `init` / `ref-init` 裹着的声明符（类型在里头那一格上）。 */
function unwrap(d) {
  const h = headOf(d);
  if (h === 'init' || h === 'ref-init') return d.items[1];
  return d;
}

for (const f of files) {
  let tree = null;
  try { tree = jncParse(tb, f, new Diagnostics()); } catch { continue; }
  for (const [specs, dcl0] of decls(tree)) {
    const dcl = unwrap(dcl0);
    if (headOf(dcl) !== 'dcl') continue;            // 无名形参那一族（formal-anon）没有声明符
    sites += 1;
    const t = readDeclType(specs, dcl);
    if (t === null) continue;
    read += 1;
    shapes.set(t.shape, (shapes.get(t.shape) ?? 0) + 1);
    const p2 = ptrsByPos(dcl);
    const s2 = suffixesByPos(dcl);
    if (t.ptrs !== p2 || t.suffixes.join(',') !== s2.join(',')) {
      bad += 1;
      if (badWhy.length < 12) {
        badWhy.push(`${f.slice(CORPUS.length + 1)}　洞名读出 ${typeText(t)}`
          + `（*${t.ptrs} ${t.suffixes.join(',')}），位置读出 *${p2} ${s2.join(',')}`);
      }
    }
  }
}

console.log(`语料 ${files.length} 份　声明 ${sites} 处　读出 ${read}`
  + `（${(read / Math.max(sites, 1) * 100).toFixed(1)}%）　两遍对不上 ${bad}`);
console.log(`形状分布：${[...shapes].sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k}×${n}`).join('  ')}`);
if (badWhy.length > 0) {
  console.log('\n对不上（照实测的修表）：');
  for (const w of (all ? badWhy : badWhy.slice(0, 8))) console.log(`  ${w}`);
}
process.exitCode = bad === 0 && read === sites ? 0 : 1;
