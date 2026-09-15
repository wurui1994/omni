// tests/lib/jnc-word-ctx.js —— **词能出现在哪儿**：词汇表的 `ctx` vs 语料的事实
//
// 先记一笔更正。这把尺子第一版问错了坐标系：我拿语料里的 (位置, **修饰词**) 组合去查
// 594 格位置矩阵，报出"矩阵漏了 59 格"—— 其实矩阵的坐标是**要素名**
// （`template-ctor-expr` / `friend` 那种"写法"），不是裸词。同一个词在矩阵里可能对应
// 好几个要素，也可能压根不是一格要素。**问错了坐标系，答案再整齐也没用。**
//
// 改成同一坐标系里的一问：`src/lang/jnc/syntax.js` 里每个词都标了 `ctx`
// （它能出现在哪几种声明上下文，抄自 jancy 的 `.llk`）—— 那是**规则**；
// 语料里真出现的 (上下文, 词) 是**事实**。两边对不上就是我把某个词的上下文标错了。
//
// 位置怎么定：树里往上找最近的容器 —— 单元顶层 `global`、聚合体里 `member`、函数体里 `local`
// （与 syntax.js 的 CONTEXTS 三格一致）。
//
// 用法：node tests/lib/jnc-word-ctx.js [文件数，默认 200] [--all]

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse } from '../../src/core/lang/jnc.js';
import { readSpecs } from '../../src/lang/jnc/specs.js';
import { headOf, named } from '../../src/lang/jnc/adapt.js';
import { readDcl, chainOf } from '../../src/lang/jnc/declare.js';
import { MODS, STORAGE, ACCESS } from '../../src/lang/jnc/syntax.js';
import { JNC_CTX_OPENS, JNC_MEMBER_BY_NAME } from '../../src/lang/jnc/nodes.js';
import { refDir } from './refsrc.js';

const EXTERNAL = refDir('jancy', 'JANCY');
const CORPUS = existsSync(EXTERNAL) ? EXTERNAL : 'tests/jnc/cases';
const argv = process.argv.slice(2);
const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 200);
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

/** 词汇表里这个词允许的上下文（没标 `ctx` 的当成"三种都行"）。 */
function allowed(word) {
  const rec = MODS[word] ?? STORAGE[word] ?? ACCESS[word];
  if (rec === undefined) return null;                 // 不在词汇表里（那是 jnc-specs 那把尺子的事）
  return rec.ctx === undefined ? ['global', 'member', 'local'] : rec.ctx;
}

initJnc({ log: () => {} });
const tb = jncFrontEnd();
const files = walk(CORPUS).sort().slice(0, limit);

const seen = new Map();          // `${ctx}|${word}` -> 次数
const where = new Map();         // 同一个键 -> 第一次见到它的文件:行（补上下文表要照着看）
let ok = 0;

/** 走树，同时带着"我现在在哪种上下文里"。 */
/** 这个节点的行号（往下找第一个带 `line` 的记号）。 */
function lineOf(n) {
  if (n === null || typeof n !== 'object') return null;
  if (n.line !== undefined) return n.line;
  if (n.span !== undefined && n.span.line !== undefined) return n.span.line;
  if (!Array.isArray(n.items)) return null;
  for (const it of n.items) {
    const l = lineOf(it);
    if (l !== null) return l;
  }
  return null;
}

let FILE = '?';

/** 一个声明语句（`fn-def` / `fn-proto` / `var-decl`）里的声明符，按洞名读，不按位置。 */
function dclsOf(n) {
  const nm = named(n);
  if (nm === null) return [];
  if (nm.dcl !== undefined) {
    const d = readDcl(nm.dcl);
    return d === null ? [] : [d];
  }
  if (nm.dcls === undefined) return [];
  const list = headOf(nm.dcls) === 'dcls'
    ? [named(nm.dcls)?.first]                                  // 单个：`dcls` 裹一格
    : chainOf(nm.dcls, 'dcls-add');                            // 多个：左递归链
  return list.map((d) => readDcl(d)).filter((d) => d !== null);
}

function visit(n, ctx) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
  const h = headOf(n);
  let inner = ctx;
  /* 体外成员定义（`override C3.baz(int x, int y) {…}`）：树上长在顶层，语义上是成员
     —— 认它声明符的**限定名**。这里必须走读取器（`named` + `readDcl`）拿 `nameNode` 的头名：
     先前是拿 `JSON.stringify(n).slice(0, 4000)` 找 `"qualified"`，记号带着 span 一格就好几十字节，
     4000 字砍在名字前头，于是 02_Inheritance.jnc:130 那一处漏判成 global —— 那就是最后一格账。 */
  if (h === 'fn-def' || h === 'var-decl' || h === 'fn-proto') {
    if (dclsOf(n).some((d) => JNC_MEMBER_BY_NAME.includes(headOf(d.nameNode)))) inner = 'member';
  }
  if (h === 'specs') {
    const got = readSpecs(n);
    if (got !== null) {
      for (const w of got.words) {
        const k = `${ctx}|${w}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        if (!where.has(k)) where.set(k, `${FILE}:${lineOf(n) ?? '?'}`);
      }
    }
  }
  /* **按洞往下走**：哪一格开哪种上下文由 `JNC_CTX_OPENS` 说（键是 `节点.洞`）。
     命名不了的节点（表里还没有）退回按位置遍历，ctx 沿用当前的。 */
  const nm = named(n);
  if (nm === null) {
    for (const it of n.items) visit(it, inner);
    return;
  }
  for (const k of Object.keys(nm)) {
    if (k === 'kind' || k === 'raw') continue;
    const opens = JNC_CTX_OPENS[`${h}.${k}`];
    visit(nm[k], opens === undefined ? inner : opens);
  }
}

for (const f of files) {
  const diags = new Diagnostics();
  FILE = f.slice(CORPUS.length + 1);
  try { visit(jncParse(tb, f, diags), 'global'); ok += 1; } catch { /* 归语料尺子 */ }
}

const bad = [];
const good = [];
const unknown = [];
for (const [k, n] of seen) {
  const [ctx, word] = k.split('|');
  const ok2 = allowed(word);
  if (ok2 === null) { unknown.push([ctx, word, n]); continue; }
  if (ok2.includes(ctx)) good.push([ctx, word, n]);
  else bad.push([ctx, word, n, ok2]);
}

console.log(`语料 ${ok}/${files.length} 份　真出现的 (上下文, 词) 组合 ${seen.size} 格`);
console.log(`规则允许 ${good.length} 格　**规则说不许、语料却有** ${bad.length} 格`
  + `　词汇表里没这个词 ${unknown.length} 格`);
if (bad.length > 0) {
  console.log('\n对不上（我把这些词的上下文标错了）：');
  for (const [c, w, n, ok2] of bad.sort((a, b) => b[2] - a[2]).slice(0, all ? 999 : 20)) {
    console.log(`  ${String(n).padStart(5)}  ${c} × ${w}　（表里只许 ${ok2.join('/')}）`
      + `　头一处：${where.get(`${c}|${w}`) ?? '?'}`);
  }
}
if (unknown.length > 0) {
  console.log('\n不在词汇表里的（归 jnc-specs 那把尺子管）：'
    + unknown.sort((a, b) => b[2] - a[2]).slice(0, 8).map(([c, w, n]) => ` ${w}×${n}`).join(''));
}
/* 那笔账**结了**（200 份语料 58 格全对得上）。结账的经过值得留一句：
   最后一格 `global × override` 不是词汇表标错，也不是 `agg` 那条链没传 ctx ——
   是 `samples/jnc/02_Inheritance.jnc:130` 的**体外成员实现** `override C3.baz(…) {…}`，
   它树上真在顶层，得认声明符的限定名。判定本来就写了，只是用
   `JSON.stringify(n).slice(0, 4000)` 找 `"qualified"` —— 记号带 span，4000 字砍在名字前头。
   换成走读取器（`named` + `readDcl` 拿 `nameNode` 的头名）就对上了。
   **教训与"问错坐标系"是同一条**：尺子自己也要按规则读树，别用字符串瞟。 */
process.exitCode = bad.length === 0 ? 0 : 1;
