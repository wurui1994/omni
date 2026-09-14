#!/usr/bin/env node
// tests/lib/jnc-rules-sweep.js —— 把**全部语料**一趟推过按表那条降级（`src/lang/jnc/lower.js`），
// 把"还没接"的那些按条目归堆印出来。
//
// 这不是对比尺子：它不看旧降级印的字，只问一件事 —— 这份源码，按表那条走不走得下来。
// 走不下来的，`lowerJncRules` 会往 diags 里记一条"规则化降级还没接：…"；这里把同一条
// 归成一堆、按堆的大小排，于是"下一刀该切哪一族"是从数里看出来的，不是猜的。
//
//   node tests/lib/jnc-rules-sweep.js            # 归堆的账 + 一行总数
//   node tests/lib/jnc-rules-sweep.js --files    # 再印每一堆底下是哪些语料
//   node tests/lib/jnc-rules-sweep.js 07 12      # 只看名字里带这些片段的

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import {
  join, isAbsolute, resolve, dirname,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostics } from '../../src/core/source/diag.js';
import { initJnc, jncFrontEnd, jncParse, jncParseExpr } from '../../src/core/lang/jnc.js';
import { lowerJncRules } from '../../src/lang/jnc/lower.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CASES = join(HERE, '..', 'jnc', 'cases');

const argv = process.argv.slice(2);
const wantFiles = argv.includes('--files');
const pick = argv.filter((a) => !a.startsWith('--'));

initJnc({ log: () => {} });
const tb = jncFrontEnd();

const files = readdirSync(CASES)
  .filter((f) => f.endsWith('.jnc'))
  .filter((f) => pick.length === 0 || pick.some((p) => f.includes(p)))
  .sort();

/* 账 -> 记了这条的语料。`crash` 那一格是**驱动自己炸了**，与"还没接"分开记：
   前者是这一层的 bug，后者是还没写的规则。

   归堆前先把账**归一化**：账里带的函数名（`show：…`）与量名（`'g_p'`）是为了指哪儿，
   归堆时反倒把同一族劈成几十条。所以把它们抹成 `…`，于是"要接哪一族"才看得出来。 */
const heap = new Map();
const canon = (s) => s
  .replace(/^[A-Za-z_$][\w$]*(\$o\d+)?：/, '')
  .replace(/'[^']*'/g, "'…'");
const note = (why, f) => {
  const k = canon(why);
  if (!heap.has(k)) heap.set(k, []);
  heap.get(k).push(f);
};

let ok = 0;
const okFiles = [];
/**
 * **import 那一族按真驱动那条路找**（第六十 / 六十二刀）：先看写这条 import 的文件自己的
 * 目录，再按 `-I` 的次序。`-I` 从 `<语料>.args` 里读 —— 那正是 `tests/jnc/run.js` 递给
 * CLI 的同一份，所以这把尺子量的与真跑的是同一件事（少了它，59-incdir.jnc 在尺子上
 * 报的是"import 找不着"，而真跑是对的）。
 */
const dirsOf = (f) => {
  let txt = '';
  try { txt = readFileSync(join(CASES, `${f.replace(/\.jnc$/, '')}.args`), 'utf8'); } catch { return []; }
  const out = [];
  const parts = txt.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '-I' && parts[i + 1] !== undefined) out.push(join(CASES, '..', parts[i + 1]));
  }
  return out;
};
for (const f of files) {
  const p = join(CASES, f);
  const d = new Diagnostics();
  const dirs = dirsOf(f);
  const find = (spec, from) => {
    if (isAbsolute(spec)) return existsSync(spec) ? resolve(spec) : null;
    const here = join(dirname(from), spec);
    if (existsSync(here)) return resolve(here);
    for (const dir of dirs) {
      const q = join(dir, spec);
      if (existsSync(q)) return resolve(q);
    }
    return null;
  };
  let out = null;
  try {
    const tree = jncParse(tb, p, d);
    out = lowerJncRules(tree, d, {
      path: p,
      needEntry: true,
      find,
      parse: (q) => jncParse(tb, q, d),
      /* 格式化字面量里 `$(…)` 那一段要**再解析一遍**（第二百刀）—— 与真驱动递的是同一个入口，
         少了它这把尺子量的就不是真跑的那件事。 */
      parseExpr: (file, src, offset) => jncParseExpr(tb, file, src, offset, d),
    });
  } catch (e) {
    note(`崩：${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120)}`, f);
    continue;
  }
  if (out !== null && out !== '') {
    ok += 1;
    okFiles.push(f);
    continue;
  }
  /* 记下的每一条都算一格账（一份语料可以拦在好几条上）。 */
  const msgs = d.format().split('\n').filter((l) => l.includes('规则化降级还没接：'));
  if (msgs.length === 0) note(`没接但没记账：${d.format().split('\n')[0].slice(0, 100)}`, f);
  for (const m of msgs) note(m.slice(m.indexOf('还没接：') + 4).trim(), f);
}

const rows = [...heap.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
for (const [why, fs] of rows) {
  console.log(`${String(fs.length).padStart(4)}  ${why}`);
  if (wantFiles) console.log(`      ${fs.join(' ')}`);
}
console.log(`\n语料 ${files.length} 份　降得下来 ${ok}（${(ok / files.length * 100).toFixed(1)}%）　拦住 ${files.length - ok}　账 ${rows.length} 条`);
if (wantFiles) console.log(`降得下来的：${okFiles.join(' ')}`);
