// tests/lib/jnc-import.js —— **导入**这一族的量：语料里的 import 都指向哪儿
//
// 跨文件那 14034 处查不着的名字（见 jnc-scope）要导入表才补得上。动手写机制之前先量清 ——
// 与节点表那一刀同一条路子：**先量清单，再写表**。
//
// jancy 的 import 是"文件名 + 一条搜索路径"（不是相对路径）：`import "std_Buffer.jnc"`
// 在 `-I` 给的几个目录里找（jnc_ct_Module 的 `m_filePathList`）。所以这儿也按**文件名**找。
//
// 三栏：
//   找着了      语料里正好有这个文件名（同名多份也算，报几份）
//   归档        `.jncx`（一个 zip，里头封着 .jnc 与共享库）—— 这一层打不开，记账
//   找不着      语料里没这个名字（那就是语料本身不全）
//
// 用法：node tests/lib/jnc-import.js [文件数，默认 全部] [--all]

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { refDir } from './refsrc.js';

const EXTERNAL = refDir('jancy', 'JANCY');
const CORPUS = existsSync(EXTERNAL) ? EXTERNAL : 'tests/jnc/cases';
const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 100000);
const all = argv.includes('--all');

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const e of names) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(CORPUS).sort();
const jnc = files.filter((f) => f.endsWith('.jnc')).slice(0, limit);
/** 文件名 -> 有几份（搜索路径就是按名字找，所以键是名字） */
const byName = new Map();
for (const f of files) {
  const b = basename(f);
  byName.set(b, (byName.get(b) ?? 0) + 1);
}

const hit = new Map();
const jncx = new Map();
const miss = new Map();
let total = 0;

for (const f of jnc) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    const path = m[1];
    total += 1;
    const b = basename(path);
    const bucket = b.endsWith('.jncx') ? jncx : (byName.has(b) ? hit : miss);
    bucket.set(path, (bucket.get(path) ?? 0) + 1);
  }
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`语料 ${jnc.length} 份 .jnc　import 共 ${total} 处、不同的路径 `
  + `${hit.size + jncx.size + miss.size} 个`);
console.log(`找着了 ${sum(hit)} 处（${hit.size} 个名字）　`
  + `归档 .jncx ${sum(jncx)} 处（${jncx.size} 个）　找不着 ${sum(miss)} 处（${miss.size} 个）`);

const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([p, c]) => `${p}×${c}`).join('  ');
if (jncx.size > 0) console.log(`\n归档（这一层打不开，记账）：${top(jncx, all ? 99 : 8)}`);
if (miss.size > 0) console.log(`\n找不着（语料不全）：${top(miss, all ? 99 : 12)}`);
/* 同名多份的那几个要留意：按名字找就有"找着哪一份"的歧义（jancy 靠 `-I` 的次序定）。 */
const dup = [...byName].filter(([b, c]) => c > 1 && b.endsWith('.jnc'));
console.log(`\n同名多份的 .jnc：${dup.length} 个`
  + `${dup.length > 0 ? `（头几个：${dup.slice(0, 6).map(([b, c]) => `${b}×${c}`).join(' ')}）` : ''}`);
