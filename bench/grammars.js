#!/usr/bin/env node
// bench/grammars.js —— **每门语言一份语法**：建表要多久、语料解析要多久
//
// 为什么要这一份：`ext/<语言>/<语言>.grammar` 会越来越多（go / vlang / nim / awk /
// chez / sbcl / freebasic / mojo / c++ …）。每加一门都手敲一遍 `time` 拼数字，
// 拼出来的数还互相不可比（进程启动、缓存命中与否、语料大小各不相同）。
//
// 这一份把那件事定死成三个数，一门语言一行：
//
//   1. **冷建表**：先把这份语法那一格缓存删掉，再 `loadGrammarTable` —— 项集族那一遍。
//      它是这条路上唯一的慢步（asy 那份量过 780ms），所以它自己一栏。
//   2. **热装表**：第二遍。它必须命中内容寻址缓存，否则这一行标 `MISS` —— 那是缓存写坏了。
//   3. **解析**：语料逐个文件 `lexText` + `glrParse`，累计 字节 / 记号 / 节点 / 毫秒。
//      吞吐印成 MB/s 与 万记号/s 两个口径 —— 前者受注释与空白影响，后者不受。
//
// 都在**同一个进程里**量（不 spawn）：进程启动那 40ms 在 8 门语言上会淹掉真正的差别。
//
// 语料在哪儿由**每门语言自己说**（`ext/<语言>/bench.json`），不写在这一份里 ——
// 与 `ext/` 的规矩一致（扩展自述，核心只按约定找）。形状：
//
//   {
//     "grammar": "lua.grammar",
//     "corpus": [
//       { "tree": "lua",  "env": "LUA_SRC", "ext": ".lua" },   // 参考树（refsrc 的口径）
//       { "dir": "tests/corpus", "ext": ".lua" }               // 这个扩展目录里自带的
//     ]
//   }
//
// 参考树不在就**跳过并说清**（不假装绿，也不假装量到了）。
//
//   node bench/grammars.js
//   node bench/grammars.js lua awk        # 只量这几门
//   node bench/grammars.js --fail         # 把解析失败的头几条印出来
//   node bench/grammars.js --md           # 印成 markdown，好贴进 DESIGN.md

import { readdirSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REF_ROOT, refDirIf } from '../tests/lib/refsrc.js';
import { loadGrammarTable } from '../src/core/glr/load.js';
import { lexText } from '../src/core/glr/lex.js';
import { glrParse } from '../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../src/core/source/diag.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(here, '..', 'ext');
const argv = process.argv.slice(2);
const only = argv.filter((a) => !a.startsWith('-'));
const showFail = argv.includes('--fail');
const asMd = argv.includes('--md');
/** 一门语言最多印几条失败（全印出来没人读，头几条足够定位一类） */
const FAIL_SHOWN = 6;

/** 一棵 s-expr 的节点数 —— 与 `omni glr --count` 同一个口径 */
function countNodes(n) {
  if (n === null || n === undefined) return 0;
  if (n.kind !== 'list') return 1;
  let sum = 1;
  for (const x of n.items) sum += countNodes(x);
  return sum;
}

/** 递归收一棵目录树里的某个后缀。`ext` 是后缀（`.lua`），不是 glob —— 够用且没有歧义。 */
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

/** 一格 `bench.json` 里的一条语料源 -> 一串文件路径（找不到答 null，让上层说"跳过"）。 */
function resolveCorpus(extDir, src) {
  if (src.dir !== undefined) return filesUnder(join(extDir, src.dir), src.ext, []);
  const tree = refDirIf(src.tree, src.env ?? null);
  if (tree === null) return null;
  return filesUnder(src.sub === undefined ? tree : join(tree, src.sub), src.ext, []);
}

const ms = (n) => `${n < 10 ? n.toFixed(1) : Math.round(n)}ms`;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

const rows = [];
const notes = [];

for (const name of readdirSync(EXT_ROOT).sort()) {
  const extDir = join(EXT_ROOT, name);
  const cfgPath = join(extDir, 'bench.json');
  if (!existsSync(cfgPath)) continue;
  if (only.length > 0 && !only.includes(name)) continue;
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const gpath = join(extDir, cfg.grammar);
  if (!existsSync(gpath)) { notes.push(`${name}: 自述里的 ${cfg.grammar} 不在`); continue; }

  // ---- 语料。少一棵树就说清少了哪一棵（这一门照旧量表，只是语料那几栏空着）
  const files = [];
  const missing = [];
  for (const src of cfg.corpus ?? []) {
    const got = resolveCorpus(extDir, src);
    if (got === null) { missing.push(src.tree); continue; }
    for (const f of got) files.push(f);
  }
  if (missing.length > 0) notes.push(`${name}: 少了参考树 ${missing.join(' / ')}（${REF_ROOT} 下没有）`);

  // ---- 1) 冷建表。先问一遍拿到缓存路径，删掉它再计时 —— 键的算法只有 load.js 那一份，
  //          这儿不复制（复制了就会有第二种说法）。
  const probe = loadGrammarTable(gpath);
  rmSync(probe.cachePath, { force: true });
  let t = performance.now();
  const cold = loadGrammarTable(gpath);
  const coldMs = performance.now() - t;

  // ---- 2) 热装表。必须命中，不然缓存那条路是坏的
  t = performance.now();
  const warm = loadGrammarTable(gpath);
  const warmMs = performance.now() - t;

  const tb = warm.tb;
  const g = tb.grammar;
  const row = {
    name,
    states: tb.states.length,
    rules: g.rules.length,
    terms: g.terms.size,
    conflicts: tb.conflicts.length,
    coldMs,
    warmMs,
    hit: warm.hit && !cold.hit,
    files: files.length,
    ok: 0,
    bytes: 0,
    tokens: 0,
    nodes: 0,
    parseMs: 0,
    fails: [],
  };

  // ---- 3) 解析。**逐个文件**量：一个文件炸了不许把整趟带走（那样就只知道"有错"）
  if (g.lex === null) {
    row.note = '没有词法段（真 bison 的词法在 .l 里）';
  } else {
    for (const f of files) {
      let text = null;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const diags = new Diagnostics();
      const t0 = performance.now();
      let tree = null;
      let toks = null;
      try {
        toks = lexText(g.lex, new SourceFile(f, text), diags);
        if (toks !== null && !diags.hasErrors()) tree = glrParse(tb, toks, diags);
      } catch (err) {
        diags.error(null, err.message);
      }
      row.parseMs += performance.now() - t0;
      row.bytes += statSync(f).size;
      /* 记号数按**扫出来的**算（哪怕语法没接住）：吞吐那两栏量的是这一趟干了多少活，
         而不是"成功了多少" —— 后者是覆盖率那一栏（`过`）的事。 */
      if (toks !== null) row.tokens += toks.length;
      if (tree === null || diags.hasErrors()) {
        const d = diags.items.find((x) => x.severity === 'error');
        row.fails.push(`${f}: ${d === undefined ? '(没有诊断)' : d.msg}`);
        continue;
      }
      row.ok++;
      row.nodes += countNodes(tree);
    }
  }
  rows.push(row);
}

// ---- 印。两种排版：默认是给终端看的定宽表，`--md` 是给 DESIGN.md 用的
const head = ['语言', '状态', '产生式', '终结符', '冲突', '冷建表', '热装表', '文件', '过', '字节', '记号', '节点', '解析', 'MB/s', '万记号/s'];
const body = rows.map((r) => [
  r.name,
  `${r.states}`,
  `${r.rules}`,
  `${r.terms}`,
  `${r.conflicts}`,
  ms(r.coldMs),
  r.hit ? ms(r.warmMs) : `MISS ${ms(r.warmMs)}`,
  `${r.files}`,
  r.note === undefined ? `${r.ok}` : '-',
  r.note === undefined ? kb(r.bytes) : '-',
  r.note === undefined ? `${r.tokens}` : '-',
  r.note === undefined ? `${r.nodes}` : '-',
  r.note === undefined ? ms(r.parseMs) : '-',
  r.note === undefined && r.parseMs > 0 ? (r.bytes / 1048576 / (r.parseMs / 1000)).toFixed(1) : '-',
  r.note === undefined && r.parseMs > 0 ? (r.tokens / 10000 / (r.parseMs / 1000)).toFixed(1) : '-',
]);

if (asMd) {
  process.stdout.write(`| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n`);
  for (const b of body) process.stdout.write(`| ${b.join(' | ')} |\n`);
} else {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  process.stdout.write(`${line(head)}\n`);
  for (const b of body) process.stdout.write(`${line(b)}\n`);
}

for (const r of rows) {
  if (r.note !== undefined) process.stdout.write(`\n${r.name}: ${r.note}\n`);
}
for (const n of notes) process.stdout.write(`\nskip ${n}\n`);

if (showFail) {
  for (const r of rows) {
    if (r.fails.length === 0) continue;
    process.stdout.write(`\n${r.name} 没过的 ${r.fails.length} 个（印头 ${FAIL_SHOWN} 条）：\n`);
    for (const f of r.fails.slice(0, FAIL_SHOWN)) process.stdout.write(`  ${f}\n`);
  }
} else if (rows.some((r) => r.fails.length > 0)) {
  process.stdout.write('\n（有没过的文件；加 --fail 看头几条）\n');
}
