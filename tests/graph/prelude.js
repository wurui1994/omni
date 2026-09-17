#!/usr/bin/env node
// tests/graph/prelude.js —— **序言按用到的那几族裁**（shrink 文档第七节第 1 条）
//
// 重量那一节量到的原话：`basics.lua` 那 435 行产物里**固定序言占 361 行（83%）**。
// 一份只印两个串的程序用不着映射那一族、列表那一族、`g_pow` —— 于是序言按名字传递地留
// （`backend-c.js` 的 `trimPrelude`：一格土生土长的摇树）。
//
// 这一格判据管三件事：
//   1. **裁得动**：`strcat.lua` 那一份里映射 / 列表 / `g_pow` 一格都不发；行数与字节都下来了
//   2. **不许漏留**：**每一份例子**（十门 × 全部）里，程序那一段用到的每一个 `g_*`
//      都得在这份产物里有定义 —— 漏一格的后果是编不动，所以这一条是这个优化的安全网
//   3. **该留的留**：用得着的那几族还在（`strcat` 要 `g_cat2` / `g_show`；`dict` 要 map 那一族）
//
// 第 2 条为什么在这儿而不是靠 `tests/graph/run.js`：那一格只跑**跑得起来**的 98 份，
// 而这一格是纯文本检查，连那 10 份因形状跳过的也一起看得住。
//
//   node tests/graph/prelude.js

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { backends, Gap } from '../../src/core/graph/contract.js';
import { CASES } from './cases.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = `${HERE}../../`;
let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };

const cBack = backends().find((b) => b.name === 'c');
const MARK = '/* ---- 编译期就知道的那几格常量';

/** 一份例子 -> 那份 C（接不住回 null —— 缺口不是失败）。 */
function cOf(c) {
  const { tb } = loadGrammarTable(`${ROOT}${c.grammar}`);
  const diags = new Diagnostics();
  const toks = lexText(tb.grammar.lex, new SourceFile(c.file, readText(`${ROOT}${c.file}`)), diags);
  const g = c.toGraph(glrParse(tb, toks, diags));
  try {
    return cBack.lower(g).text;
  } catch (err) {
    if (err instanceof Gap) return null;
    throw err;
  }
}

const found = new Map();
for (const c of CASES) {
  const t = cOf(c);
  if (t !== null) found.set(c.name, t);
}

// ---- 2) 不许漏留：每一份产物里，用到的 `g_*` 都要有定义
{
  let bad = 0;
  for (const [name, t] of found) {
    const i = t.indexOf(MARK);
    const prog = i < 0 ? t : t.slice(i);
    /* 定义 = `static <类型…> g_xxx(`（原型与定义同名，有一处就算定义得出来）。 */
    const defs = new Set();
    for (const m of t.matchAll(/static[^\n(]*?\b(g_[A-Za-z0-9_]+)\s*\(/g)) defs.add(m[1]);
    const used = new Set(prog.match(/\bg_[A-Za-z0-9_]+/g) ?? []);
    const miss = [...used].filter((x) => !defs.has(x));
    if (miss.length > 0) {
      no(`不许漏留〔${name}〕`, `这份 C 用了却没定义：${miss.join('、')}`);
      bad += 1;
    }
  }
  if (bad === 0) ok(`不许漏留〔${found.size} 份产物，用到的 g_* 全都有定义〕`);
}

// ---- 1) 裁得动 + 3) 该留的留
const one = (name) => {
  const t = found.get(name);
  if (t === undefined) { no(`裁〔${name}〕`, '这份例子没出 C（缺口？名字改了？）'); return null; }
  return t;
};
{
  const t = one('lua+strcat');
  if (t !== null) {
    const lines = t.split('\n').length;
    const has = (n) => (t.includes(n) ? ok(`strcat〔该留的留：${n}〕`) : no(`strcat〔该留的留：${n}〕`, '被裁掉了'));
    const hasnt = (n) => (!t.includes(n) ? ok(`strcat〔裁掉了：${n}〕`) : no(`strcat〔裁掉了：${n}〕`, '还在'));
    hasnt('g_map_new');
    hasnt('g_list_new');
    hasnt('g_pow');
    hasnt('g_slice');
    has('g_cat2');
    has('g_show');
    /* 量到的数（2026-09-17）：167 行。写「小于 200」而不是等号：这一份的程序那一段
     * 会随着 lua 那门映射的改动动几行，而「序言又胖回去」才是这一格要拦的事。 */
    if (lines < 200) ok(`strcat〔整份 ${lines} 行（裁之前 377 行）〕`);
    else no('strcat〔行数〕', `${lines} 行 —— 序言是不是又胖回去了`);
  }
}
{
  const t = one('lua+dict');
  if (t !== null) {
    if (t.includes('g_map_new')) ok('dict〔用得着 map 那一族，就留着〕');
    else no('dict〔map 那一族〕', 'map 那一族被裁掉了 —— 这一份用得着它');
  }
}
{
  /* 那份「含全部基础要素的完整例子」在 `cases.js` 里就叫 `lua`（没有后缀）。 */
  const t = one('lua');
  if (t !== null) {
    const lines = t.split('\n').length;
    if (lines < 300) ok(`basics〔整份 ${lines} 行（裁之前 435 行，其中序言 361）〕`);
    else no('basics〔行数〕', `${lines} 行 —— 序言是不是又胖回去了`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（序言按用到的族裁：裁得动 · 不许漏留 · 该留的留）\n`);
if (fail > 0) process.exit(1);
