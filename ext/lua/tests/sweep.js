// ext/lua/tests/sweep.js —— **语料尺子**：把 gsl-shell 的全部 .lua 读一遍
//
// 两问（都不需要手写用例）：
//
//   1. **认不认**：解析器收不收这个文件（不收就印那一行的抱怨，按原因归堆）
//   2. **写回去一样吗**：`render(parse(src))` 再 `parse` 再 `render`，两次必须**逐字相同**
//      —— 这一问抓的是"表与驱动器对不上"（`syn` 少了一格、可选组判错），
//      因为解析器与写回器读的是同一张表，对不上就一定是表错了。
//
// 用法：node ext/lua/tests/sweep.js [语料目录] [--fail 只印失败]
// 默认语料：/Users/wurui/Documents/Lang/reference/gsl-shell

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, ParseError } from '../parse.js';
import { render } from '../render.js';
import { luaLang } from '../lang.js';
import { gslLang } from '../../gsl-shell/lang.js';
import { luajitLang } from '../../luajit/lang.js';

/** 用哪门语言量：`--gsl` / `--luajit` 换方言（Lua + 增量表），默认 Lua 本身。 */
const lang = process.argv.includes('--gsl') ? gslLang
  : process.argv.includes('--luajit') ? luajitLang : luaLang;

const argv = process.argv.slice(2);
const root = argv.find((a) => !a.startsWith('-'))
  ?? '/Users/wurui/Documents/Lang/reference/gsl-shell';
const onlyFail = argv.includes('--fail');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.lua')) out.push(p);
  }
  return out;
}

/** 把抱怨归成"堆"：去掉行号与具体字面量，只留形状。 */
function bucket(msg) {
  return msg.replace(/^\d+ 行：/, '').replace(/'[^']*'/g, "'…'");
}

const files = walk(root).sort();
const piles = new Map();
let okCnt = 0;
let rtCnt = 0;
const bad = [];

for (const f of files) {
  const src = readFileSync(f, 'utf8').replace(/^#![^\n]*\n/, '');   // 允许 shebang
  let ast;
  try {
    ast = parse(src, lang);
  } catch (err) {
    if (!(err instanceof ParseError) && err.name !== 'LexError') throw err;
    const key = bucket(err.message);
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(`${f.slice(root.length + 1)}:${err.line ?? '?'}`);
    bad.push(f);
    continue;
  }
  okCnt += 1;
  const once = render(ast, lang);
  let twice;
  try {
    twice = render(parse(once, lang), lang);
  } catch (err) {
    const key = `写回去自己不认：${bucket(err.message)}`;
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(f.slice(root.length + 1));
    continue;
  }
  if (once === twice) rtCnt += 1;
  else {
    const line = once.split('\n').findIndex((x, i) => x !== twice.split('\n')[i]);
    const key = '两次写回不一样';
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(`${f.slice(root.length + 1)}:${line + 1}`);
  }
}

const pct = (n) => `${((n / files.length) * 100).toFixed(1)}%`;
console.log(`语料 ${root}　尺子 ${lang.name}`);
console.log(`文件 ${files.length}　收 ${okCnt}（${pct(okCnt)}）　幂等 ${rtCnt}（${pct(rtCnt)}）`);
if (piles.size > 0) {
  console.log('\n理由板（按格数排）：');
  for (const [k, v] of [...piles].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(v.length).padStart(4)}  ${k}`);
    if (!onlyFail) console.log(`        ${v.slice(0, 3).join('  ')}${v.length > 3 ? ' …' : ''}`);
  }
}
process.exitCode = okCnt === files.length && rtCnt === files.length ? 0 : 1;
