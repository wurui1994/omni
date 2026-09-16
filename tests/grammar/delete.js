#!/usr/bin/env node
// Omni — **语法层的可删除测试**（`target.md` 那一问的第二层答案）
//
// 节点层的那份在 `tests/graph/delete.js`：删掉一格节点，不用它的例子必须照旧全绿。
// 可 `target.md` 问的是"删了一个重要特性"，而**特性在这个项目里横跨两层** ——
// 一门语言的 `for` 既是语法里的几条产生式，也是图上的 `loop`。只测节点那一层，
// 就等于只答了一半：语法里删掉一支，别的程序还解析得出来吗？
//
// 判据（全是机械的，与节点那份同一套纪律）：
//
//   1. **删一支产生式，剩下的语法还得能建表**。建不出来是一档单独的结果（有名有姓，
//      不算失败）：那支通常是某个非终结符的最后一支，删了它那个名字就没有产生式了。
//   2. **不用它的例子必须解析出与原来逐字相同的树**。这就是"源码不需要到处改动"在语法层
//      的可执行版本。树用 `printSexpr` 取指纹 —— 比"解析没崩"强得多。
//   3. **用了它的例子必须干净地失败**（诊断，不是异常）。解析成功但**树不一样**是最坏的
//      情况：那说明删掉一支之后，同一份源码悄悄换了另一种解析 —— 一律算失败。**唯一的例外
//      也是机械判的**：这份例子的基线树本来就是 `(prefer N)` 从两棵里挑的（把偏好抹平就
//      报歧义），那么另一棵浮上来是这门语法自己承认的二义，归"歧义"那一档，数出来（见
//      `noPrefer`）。九门里只有 cpp 写了 prefer，所以别的语言这一档恒为 0。
//
// 于是"级联半径"在这一层也是**数出来的**：一支产生式删了会让几份例子解析不出来。
//
// ## 为什么默认只跑两门小语法
//
// 量过（`node tests/grammar/delete.js --all`）：十门语法一共 3100 条产生式，
// 一次建表平均 140ms —— 整跑一遍是分钟级的（cpp 一门 515 条，单跑 130s）。这条轴因此**按语法给**：
// 默认跑 chez 与 sbcl（两门 datum 语法，加起来 62 条，秒级），要全量就自己加 `--all`。
// 这不是"挑好看的跑"：判据对每一门都一样，跑哪几门是**时间的事**，写在这儿明说。
//
//   node tests/grammar/delete.js              # 默认：chez + sbcl
//   node tests/grammar/delete.js go nim       # 指定几门
//   node tests/grammar/delete.js --all        # 九门全跑（慢）

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGrammar } from '../../src/core/glr/grammar.js';
import { buildTable } from '../../src/core/glr/table.js';
import { grammarTextOf } from '../../src/core/glr/load.js';
import { readSexpr } from '../../src/core/sexpr/read.js';
import { printSexpr } from '../../src/core/sexpr/print.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { CASES } from '../graph/cases.js';

const ROOT = `${join(dirname(fileURLToPath(import.meta.url)), '../..')}/`;
const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const only = argv.filter((a) => !a.startsWith('-'));
/** 默认只跑这两门 —— 理由（时间）写在文件头，不是挑好看的。 */
const SMALL = ['chez', 'sbcl'];

const readText = (p) => readFileSync(p, 'utf8');
const langOf = (c) => c.name.split('+')[0];

/** 一份语法 -> 语法对象。语法自己写错了当场炸（那不是这条轴要量的东西）。 */
function grammarOf(path) {
  const diags = new Diagnostics();
  const g = readGrammar(readSexpr(new SourceFile(path, grammarTextOf(`${ROOT}${path}`, diags)), diags), diags);
  if (g === null || diags.hasErrors()) throw new Error(`语法读不进来：${diags.items[0]?.msg}`);
  return g;
}

/**
 * 删掉第 k 条产生式。下标要重排（`nonterms[].rules` 存的是下标）——
 * 这一格就是"删一格特性"在语法层的**一处**改动。
 */
function without(g, k) {
  const rules = g.rules.filter((_, i) => i !== k);
  const nonterms = new Map();
  for (const [nm] of g.nonterms) nonterms.set(nm, { name: nm, rules: [] });
  rules.forEach((r, i) => nonterms.get(r.lhs).rules.push(i));
  return { ...g, rules, nonterms };
}

/**
 * 同一份语法，**把偏好全抹平**（`(prefer N)` 当没写）。
 *
 * 用处是给"删了一支之后换了另一棵树"这一档**分两种**。判据要机械，不能靠我说哪个是例外：
 *   * 抹平偏好之后这份例子**报歧义** —— 说明基线那棵树本来就是 `prefer` 从两棵里挑的。
 *     那么删掉被挑中的那一支、另一棵浮上来，是这门语法**自己承认的二义**（cpp 的
 *     `printf(…)` 既能读成调用也能读成声明），归"歧义"这一档：要数出来、要写在报告里，
 *     不算失败 —— 它量的正是 task #15 那笔账（驱动器回问"这名字登记成类型了吗"）的大小。
 *   * 抹平偏好之后照旧单解 —— 那"另一棵树"就是真的悄悄变样了，照旧算失败。
 * 一处 `prefer` 都没写的语法（另外九门）抹平是空操作，这一档永远是 0。
 */
const noPrefer = (g) => ({ ...g, rules: g.rules.map((r) => ({ ...r, prefer: 0 })) });

/**
 * 拿一张表解析一份源码。三种结果：
 *   `{ ok: 树的指纹 }` · `{ bad: '一句人话' }`（干净地失败）· `{ crash: '…' }`（异常）
 */
function parseWith(tb, lex, file, text) {
  const diags = new Diagnostics();
  try {
    const toks = lexText(lex, new SourceFile(file, text), diags);
    if (toks === null || diags.hasErrors()) return { bad: `词法：${diags.items[0]?.msg ?? '?'}` };
    const tree = glrParse(tb, toks, diags);
    if (tree === null || diags.hasErrors()) return { bad: `语法：${diags.items[0]?.msg ?? '?'}` };
    return { ok: printSexpr(Array.isArray(tree) ? tree : [tree]) };
  } catch (err) {
    return { crash: err.message };
  }
}

/** 一条产生式印成人话（`Exp -> Exp "+" Exp`）—— 报告里要认得出是哪一支。 */
const ruleText = (r) => `${r.lhs} -> ${r.rhs.length === 0 ? 'ε' : r.rhs.join(' ')}`;

let pass = 0;
let fail = 0;
const failures = [];

// 例子按语言归堆：一门语法的所有例子共用一次建表
const byLang = new Map();
for (const c of CASES) {
  const lang = langOf(c);
  if (!byLang.has(lang)) byLang.set(lang, { grammar: c.grammar, files: [] });
  byLang.get(lang).files.push(c.file);
}

const langs = [...byLang.keys()].filter((l) => (only.length > 0 ? only.includes(l) : (wantAll || SMALL.includes(l))));
if (langs.length === 0) {
  process.stdout.write(`没有要跑的语言（认得的：${[...byLang.keys()].join(' ')}）\n`);
  process.exit(1);
}

for (const lang of langs) {
  const { grammar, files } = byLang.get(lang);
  const g = grammarOf(grammar);
  const base = buildTable(g);
  // 基线：每份例子的树指纹。基线自己不过就不用往下比了
  const texts = files.map((f) => ({ file: f, text: readText(`${ROOT}${f}`) }));
  const want = new Map();
  /** 抹平偏好之后就报歧义的那些例子 —— 它们的基线树是 `prefer` 挑出来的（见 noPrefer） */
  const preferDecided = new Set();
  const flat = buildTable(noPrefer(g));
  let baseOk = true;
  for (const { file, text } of texts) {
    const r = parseWith(base, g.lex, file, text);
    if (r.ok === undefined) {
      process.stdout.write(`  FAIL ${lang} 基线就解析不出来 ${file}：${r.bad ?? r.crash}\n`);
      fail++; baseOk = false; continue;
    }
    want.set(file, r.ok);
    if (parseWith(flat, g.lex, file, text).ok !== r.ok) preferDecided.add(file);
  }
  if (!baseOk) continue;

  let noTable = 0;
  let ambig = 0;        // 删了这支之后换了另一棵树，而这份例子的基线本来就是 prefer 定的
  const used = [];      // 删了它就有例子解析不出来的那些（半径 > 0）
  const spare = [];     // 删了它所有例子照旧（这门语言的例子用不到的那些）
  const radius = new Map(texts.map(({ file }) => [file, 0]));
  const t0 = Date.now();
  for (let k = 0; k < g.rules.length; k++) {
    let tb = null;
    try {
      tb = buildTable(without(g, k));
    } catch {
      noTable++;          // 那支通常是某个非终结符的最后一支 —— 有名有姓的一档，不算失败
      continue;
    }
    let broke = 0;
    for (const { file, text } of texts) {
      const r = parseWith(tb, g.lex, file, text);
      if (r.crash !== undefined) {
        failures.push(`${lang} 删掉 ${ruleText(g.rules[k])} 之后 ${file} **抛异常**：${r.crash}`);
        fail++; continue;
      }
      if (r.bad !== undefined) { broke++; radius.set(file, radius.get(file) + 1); continue; }
      if (r.ok !== want.get(file)) {
        // 最坏的一档：还是解析成功，但**换了另一种解析** —— 那才是"删一格会让别处悄悄变样"。
        // 例外只有一种，而且是机械判的：这份例子的基线本来就是 prefer 从两棵里挑的
        // （抹平偏好就报歧义）。那种情况归"歧义"这一档，数出来。
        if (preferDecided.has(file)) { ambig++; continue; }
        failures.push(`${lang} 删掉 ${ruleText(g.rules[k])} 之后 ${file} 解析出**另一棵树**`);
        fail++; continue;
      }
      pass++;
    }
    (broke > 0 ? used : spare).push(k);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`  ok   ${lang}：产生式 ${g.rules.length} 条`
    + ` · 例子用到 ${used.length} 条 · 备用 ${spare.length} 条 · 建不出表 ${noTable} 条`
    + (preferDecided.size === 0 ? '' : ` · prefer 定的例子 ${preferDecided.size} 份（换了另一棵树 ${ambig} 处）`)
    + `（${secs}s）\n`);
  for (const { file } of texts) {
    process.stdout.write(`         ${file.replace(`ext/${lang}/examples/`, '')} 要 ${radius.get(file)} 条产生式\n`);
  }
}

for (const m of failures) process.stdout.write(`  FAIL ${m}\n`);
process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `（删一支产生式 × 重新解析每份例子；跑了 ${langs.join(' ')}）\n`);
if (fail > 0) process.exit(1);
