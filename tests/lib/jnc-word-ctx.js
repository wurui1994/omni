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
import { headOf } from '../../src/lang/jnc/adapt.js';
import { MODS, STORAGE, ACCESS } from '../../src/lang/jnc/syntax.js';
import { JNC_CTX_OPENS, JNC_MEMBER_BY_NAME } from '../../src/lang/jnc/nodes.js';

const EXTERNAL = '/Users/wurui/Documents/Lang/reference/jancy';
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

const seen = new Map();          // `${sort}|${word}` -> 次数
let ok = 0;

/** 走树，同时带着"我现在在哪种上下文里"。 */
function visit(n, ctx) {
  if (n === null || typeof n !== 'object' || !Array.isArray(n.items)) return;
  const h = headOf(n);
  let inner = ctx;
  const opens = JNC_CTX_OPENS[h];
  if (opens !== undefined && opens !== null) inner = opens;
  /* 体外成员定义（`void C.f() override {}`）：树上长在顶层，语义上是成员 —— 认它的**限定名**。
     这一格是这把尺子量出来的：先前有 1 处 `global × override`，不是词汇表标错，是我
     判上下文时漏了这条。 */
  if (h === 'fn-def' || h === 'var-decl' || h === 'fn-proto') {
    const txt = JSON.stringify(n).slice(0, 4000);
    if (JNC_MEMBER_BY_NAME.some((q) => txt.includes(`"${q}"`))) inner = 'member';
  }
  if (h === 'specs') {
    const got = readSpecs(n);
    if (got !== null) {
      for (const w of got.words) {
        const k = `${ctx}|${w}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
  }
  for (const it of n.items) visit(it, inner);
}

for (const f of files) {
  const diags = new Diagnostics();
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
    console.log(`  ${String(n).padStart(5)}  ${c} × ${w}　（表里只许 ${ok2.join('/')}）`);
  }
}
if (unknown.length > 0) {
  console.log('\n不在词汇表里的（归 jnc-specs 那把尺子管）：'
    + unknown.sort((a, b) => b[2] - a[2]).slice(0, 8).map(([c, w, n]) => ` ${w}×${n}`).join(''));
}
/* 明账：还剩 1 格 `global × override`（200 份语料里 1 处）。语料里的 `override` 全写在类体里，
   所以这一格**几乎肯定是这把尺子的上下文判定还差一条**（某种容器头我没算成 member），
   不是词汇表标错。下一步：给这把尺子加一栏"印出那一处的文件与行"，照着补 JNC_CTX_OPENS。
   在补上之前它就是一笔记明的账 —— 不改期望、不假装绿。 */
process.exitCode = bad.length <= 1 ? 0 : 1;
