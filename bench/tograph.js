#!/usr/bin/env node
// bench/tograph.js —— **自举尺子的第二层**：那门语言自己的编译器，我们能把多少份**落成图**
//
// ADR-0037 §5.1a 那把尺子问的是"用我们的腿能不能编 go / nim / v 自己的编译器"。那条路是
//
//     源码 --解析--> 树 --映射--> 节点图 --后端--> js / c / 核心方言
//
// 第一层（解析）已经有量了：`bench/grammars.js`（go 8114/8218、nim、vlang 各自一行）。
// 这一份量**第二层**：解析过的那些里，有多少份 `xxxToGraph(tree)` 走得通，走不通的
// **卡在哪句话上**（按错误消息归类，印前几条）。
//
// 为什么单独一份而不是塞进 grammars.js：那一份量的是"语法收不收得下"（吞吐、冷热建表），
// 这一份量的是"映射写全了没有"。两件事的分母都是文件，但**结论落在不同的清单上** ——
// 前者改 `.grammar`，后者改 `tograph.js`。混在一行里，看的人分不清该改哪一处。
//
// 语料由每门语言自己说：`ext/<语言>/bench.json` 的 **`selfhost`** 那一格（"它自己的编译器
// 在哪棵子树下"）。没有那一格就跳过并说清 —— 与 grammars.js 同一条纪律。
//
//   node bench/tograph.js              三门都跑
//   node bench/tograph.js nim          只跑一门
//   node bench/tograph.js --limit 200  每门最多跑这么多份（改映射的时候快看一眼）
//   node bench/tograph.js --walls 20   墙那一栏印前几条

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGrammarTable } from '../src/core/glr/load.js';
import { lexText } from '../src/core/glr/lex.js';
import { glrParse } from '../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../src/core/source/diag.js';
import { LANGS } from '../src/core/graph/langs.js';
import { refDirIf } from '../tests/lib/refsrc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const numArg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i < 0 ? dflt : Number(argv[i + 1]);
};
/* **带值的开关后面那一格不是语言名**：`--walls 8` 里的 `8` 原来被当成语言过滤器，
   于是 `node bench/tograph.js --walls 8` 报"一门都没量到"。 */
const VALUED = new Set(['--limit', '--walls']);
const only = argv.filter((a, i) => !a.startsWith('-') && !VALUED.has(argv[i - 1]));
const LIMIT = numArg('--limit', 0);
const WALLS = numArg('--walls', 8);

/** 递归收一棵目录树里的某个后缀（与 grammars.js 那一份同形）。 */
function filesUnder(dir, ext, out) {
  let names = null;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of names) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 一句错误消息**归一**成一格墙：把里面的名字与数字抹掉，不然每份文件都是一条新墙。 */
function wallOf(msg) {
  return String(msg)
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/[0-9]+/g, 'N')
    .slice(0, 110);
}

/** 这门语言的 `selfhost` 语料（`ext/<语言>/bench.json`）。没那一格或树不在就回 null。 */
function corpusOf(lang) {
  let conf = null;
  try {
    conf = JSON.parse(readFileSync(join(ROOT, 'ext', lang.name, 'bench.json'), 'utf8'));
  } catch {
    return null;
  }
  const sh = conf.selfhost;
  if (sh === undefined) return null;
  const tree = refDirIf(sh.tree, sh.env ?? null);
  if (tree === null) return { root: null, files: [] };
  const root = sh.sub === undefined ? tree : join(tree, sh.sub);
  return { root: root, files: filesUnder(root, sh.ext, []) };
}

/** 一门语言跑一遍：解析 -> 落图，两层各自的过与没过，加一张墙的清单。 */
function measure(lang) {
  const got = corpusOf(lang);
  if (got === null) return { skip: `ext/${lang.name}/bench.json 里没有 selfhost 那一格` };
  if (got.root === null) return { skip: '参考树不在（那门语言的源码没在本机上）' };
  let files = got.files;
  if (LIMIT > 0) files = files.slice(0, LIMIT);
  if (files.length === 0) return { skip: `${got.root} 底下一份都没有` };
  const { tb } = loadGrammarTable(join(ROOT, lang.grammar));
  const row = {
    root: got.root, files: files.length, parsed: 0, graphed: 0, bytes: 0, ms: 0,
  };
  const walls = new Map();
  const bump = (msg, path) => {
    const k = wallOf(msg);
    const w = walls.get(k) ?? { n: 0, first: path };
    w.n = w.n + 1;
    walls.set(k, w);
  };
  const t0 = Date.now();
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    row.bytes += text.length;
    const diags = new Diagnostics();
    let tree = null;
    try {
      const toks = lexText(tb.grammar.lex, new SourceFile(p, text), diags);
      if (toks !== null && !diags.hasErrors()) tree = glrParse(tb, toks, diags);
    } catch {
      tree = null;
    }
    if (tree === null || diags.hasErrors()) continue;      // 第一层的账在 grammars.js 上
    row.parsed += 1;
    try {
      lang.toGraph(tree);
      row.graphed += 1;
    } catch (err) {
      bump(err.message, p);
    }
  }
  row.ms = Date.now() - t0;
  row.walls = [...walls.entries()].sort((a, b) => b[1].n - a[1].n);
  return row;
}

const pct = (a, b) => (b === 0 ? '  —  ' : `${((a / b) * 100).toFixed(1)}%`);
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

/* `LANGS` 是一格 Map（名字 -> 那门语言那一栏），所以这儿把名字与那一栏配成一对。 */
const names = [...LANGS.entries()]
  .map(([name, l]) => ({ name: name, grammar: l.grammar, toGraph: l.toGraph }))
  .filter((l) => (only.length === 0 ? true : only.includes(l.name)))
  .filter((l) => typeof l.toGraph === 'function');
const rows = [];
for (const lang of names) {
  const r = measure(lang);
  if (r.skip !== undefined) {
    if (only.length > 0) process.stdout.write(`${lang.name}：跳过 —— ${r.skip}\n`);
    continue;
  }
  rows.push([lang, r]);
}

if (rows.length === 0) {
  process.stdout.write('一门都没量到（`selfhost` 那一格只有 go / nim / vlang 三门有）。\n');
} else {
  process.stdout.write('语言      文件    解析过        落成图         字节    用时  子树\n');
  for (const [lang, r] of rows) {
    process.stdout.write(`${lang.name.padEnd(9)}${String(r.files).padStart(5)}`
      + `${String(r.parsed).padStart(7)} ${pct(r.parsed, r.files).padStart(6)}`
      + `${String(r.graphed).padStart(7)} ${pct(r.graphed, r.parsed).padStart(6)}`
      + `${mb(r.bytes).padStart(9)}${`${(r.ms / 1000).toFixed(1)}s`.padStart(8)}`
      + `  ${relative(ROOT, r.root)}\n`);
  }
  for (const [lang, r] of rows) {
    if (r.walls.length === 0) continue;
    const shown = r.walls.slice(0, WALLS);
    const rest = r.walls.length - shown.length;
    process.stdout.write(`\n${lang.name} 的墙（${r.parsed - r.graphed} 份没落成图，`
      + `${r.walls.length} 条不同的话${rest > 0 ? `，印前 ${shown.length} 条` : ''}）：\n`);
    for (const [msg, w] of shown) {
      process.stdout.write(`  ${String(w.n).padStart(5)}  ${msg}\n`);
    }
  }
  process.stdout.write('\n这一份量的是**映射写全了没有**（改的是 ext/<语言>/tograph.js）；'
    + '语法那一层的账在 bench/grammars.js 上。\n');
}

