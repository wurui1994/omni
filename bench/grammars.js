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
//     ],
//     "invalid": { "paths": ["/testdata/"], "marker": "ERROR" }  // **故意写错的**用例，见下
//   }
//
// ## `invalid`：**故意写错的用例不算覆盖率**
//
// 真语言的仓库里躺着一大批**故意不合法**的文件：go 的 `internal/syntax/testdata/` 里
// 每一份都带着 `// ERROR …` 标记，gawk 的 `test/badassign1.awk` 写的是 `$i++ = 3`。
// 那些文件语法分析器**就该拒**。把它们算进"没过"里，覆盖率那一栏永远到不了顶，而且
// 会把"我们还欠什么"记糊 —— 分不清"我们读不了"与"它本来就不该读得了"。
//
// 两种写法：
//   `"invalid": ["tests/"]`                       整个目录都是故意写坏的（fbc 那种）
//   `"invalid": {"paths": […], "marker": "ERROR"}` 目录里好坏混着，还得看文本里的标记
//
// 命中的文件单独一栏 `坏例`，**不进 `文件` 与 `过` 的分母分子**。反过来，坏例里要是有
// **居然过了**的，那一栏会写成 `N+M`（M 份居然过了）—— 那是另一种错：语法收得太宽。
// 两个方向都不许糊过去。
//
// 参考树不在就**跳过并说清**（不假装绿，也不假装量到了）。
//
// ## `preprocess`：**读别人的源码时，先展开宏**
//
// 有的语言里"没预处理"就是墙本身。cpp 那条语料量出来：没过的 321 份里 99 份卡在
// 「宏调用当顶层声明」（`TEST(A, B) { … }`），89% 是 gtest 一家的五个宏。所以 `bench.json`
// 里可以配一格：
//
//   "preprocess": { "cap": "c.preprocess", "skipMissingIncludes": true,
//                   "defines": [["TEST(a, b)", "void a##_##b##_Test()"], …] }
//
// `-I` 是**量出来的那两条**（文件自己的目录 + 语料那棵树的根）：一份文件真正该配哪几个
// 只有那棵树的构建系统知道，所以找不到的头跳过（就是 `omni c cpp --skip-missing-includes`）。
// 预处理自己炸了的那几份**退回原文**再读，数目单独印一行。
//
// 两件事要说清：
//   * `过` 那一栏印成 `预处理后/原样` —— **那门语言自己（`omni run x.cpp`）还不做预处理**，
//     两个数摆在一起才不会走散。
//   * 跳过的每一份头都往 stderr 记一条警告（cpp 那趟 7626 行）。那是账不是噪音；
//     只想看表就 `2>/dev/null`。
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
/* 语料那一侧的预处理（`bench.json` 的 `preprocess` 那一格）。直接拿这门语言的函数 ——
   这一趟不启插件注册表，`cap('c.preprocess')` 在这儿没人往里放过东西。 */
import { cppText } from '../src/core/lang/c.js';

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

/**
 * 一格 `bench.json` 里的 `preprocess` -> 一个 `(路径) -> 文本` 的函数（没这一格答 null）。
 *
 * 语料这一侧为什么要它：读**别人的源码**时"宏没展开"是墙里最厚的一层 ——
 * `TEST(A, B) { … }` 这种宏在**声明位置**展开出一整个函数定义，不展开只能读成"一个调用
 * 当声明"。而一份文件该配哪几个 `-I` 只有那棵树的构建系统知道，所以配 `skipMissingIncludes`
 * （找不到的头当空文件，就是 `omni c cpp --skip-missing-includes` 那一格）。
 *
 * **这一栏与那门语言自己的默认不是一件事**：`omni run x.cpp` 现在**不**做预处理。
 * 两个数都要说得出来，所以 `过` 那一栏印的是 `预处理后/原样`（见 `row.okRaw`）。
 *
 * **系统头默认也不找**（`systemIncludes` 不写就是 `false`）。这一格是量出来的，不是省事：
 * 把 SDK 那几条搜索路径接上，cpp 那一栏从 **79 掉到 69**（没有前言那一版是 71 -> 61）——
 * 真进来的头里 `stdarg.h` 一族写着 `typedef __builtin_va_list va_list;`，而这门语法不认
 * `__builtin_va_list` 这个类型名，于是几十份当场卡在它上面。语料这一栏量的是"**这份 `.cc`
 * 自己**读不读得动"，拿系统头去换那十份过数不值。
 */
function preOf(cfg, extDir, treeDirs) {
  const p = cfg.preprocess;
  if (p === undefined) return null;
  if (p.cap !== 'c.preprocess') throw new Error(`bench.json: 不认识的 preprocess.cap ${p.cap}`);
  /* `includes`：开工前先压上的那几份（`-include` 那一格）。路径相对这个扩展目录 ——
     语料树里没有它们，它们是**这条语料的口径**的一部分（见 ext/cpp/corpus-prelude.h）。 */
  const incls = (p.includes ?? []).map((x) => join(extDir, x));
  return (f) => cppText(f, [dirname(f), ...treeDirs, ...(p.includeDirs ?? [])], p.defines ?? [],
    0, 1, undefined, p.systemIncludes === true ? undefined : [],
    incls.length === 0 ? undefined : incls, 0, undefined,
    p.skipMissingIncludes === true);
}


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
  const all = [];
  const missing = [];
  const treeDirs = [];
  for (const src of cfg.corpus ?? []) {
    const got = resolveCorpus(extDir, src);
    if (got === null) { missing.push(src.tree); continue; }
    for (const f of got) all.push(f);
    /* 预处理那一格要的 `-I 树根`：语料在哪棵树里，那棵树的根就是它自己的 include 起点。 */
    const tree = src.dir !== undefined ? join(extDir, src.dir) : refDirIf(src.tree, src.env ?? null);
    if (tree !== null && !treeDirs.includes(tree)) treeDirs.push(tree);
  }
  const pre = preOf(cfg, extDir, treeDirs);
  if (missing.length > 0) notes.push(`${name}: 少了参考树 ${missing.join(' / ')}（${REF_ROOT} 下没有）`);

  /* 故意写错的用例挑出来（见文件头 `invalid` 那一段）：它们**不进覆盖率**，
     单独一栏，而且"居然过了"的也要数出来。
     两种写法：一串路径片段，或者 `{paths, marker}` —— 后者多要一句"文本里得有这个标记"，
     go 的 `testdata/` 底下既有故意写错的（带 `// ERROR`）也有好的，只按目录分不开。 */
  const inv = cfg.invalid ?? [];
  const invPaths = Array.isArray(inv) ? inv : (inv.paths ?? []);
  const invMarker = Array.isArray(inv) ? null : (inv.marker ?? null);
  const isInvalid = (f) => {
    if (!invPaths.some((p) => f.includes(p))) return false;
    if (invMarker === null) return true;
    try {
      return readFileSync(f, 'utf8').includes(invMarker);
    } catch {
      return false;
    }
  };
  const files = [];
  const bad = [];
  for (const f of all) (isInvalid(f) ? bad : files).push(f);

  // ---- 1) 冷建表。先问一遍拿到缓存路径，删掉它再计时 —— 键的算法只有 load.js 那一份，
  //          这儿不复制（复制了就会有第二种说法）。
  //          语法自己写错了（比如词法能发一格语法接不住的记号）不许把整趟带走：
  //          那一门标一行 `语法读不进来`，别的照量。
  let probe = null;
  try {
    probe = loadGrammarTable(gpath);
  } catch (err) {
    notes.push(`${name}: 语法读不进来 —— ${String(err.message).split('\n')[0]}`);
    continue;
  }
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
    /** 不预处理时过几份（没配 `preprocess` 的语言与 `ok` 相同）—— 两个数都得说得出来 */
    okRaw: 0,
    /** 预处理自己炸了几份（那些**退回原文**再读，不许悄悄少算一份语料） */
    ppFail: 0,
    bad: bad.length,
    badOk: 0,
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
      let raw = null;
      try {
        raw = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      /* 配了 `preprocess` 的语言：读的是预处理后的文本。预处理自己炸了就**退回原文**
         （那一份照旧算一份语料，只是多记一笔 `ppFail`）。 */
      let text = raw;
      if (pre !== null) {
        try {
          text = pre(f);
        } catch {
          row.ppFail++;
          text = raw;
        }
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
    /* 「不预处理时过几份」那一栏。配了 `preprocess` 的语言才多读一遍原文 ——
       这一遍**不进吞吐**（同一批语料读两次，字节数就不是这一趟干的活了）。 */
    if (pre === null) {
      row.okRaw = row.ok;
    } else {
      for (const f of files) {
        let raw = null;
        try {
          raw = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        const d2 = new Diagnostics();
        let t2 = null;
        try {
          const tk = lexText(g.lex, new SourceFile(f, raw), d2);
          if (tk !== null && !d2.hasErrors()) t2 = glrParse(tb, tk, d2);
        } catch (err) {
          d2.error(null, err.message);
        }
        if (t2 !== null && !d2.hasErrors()) row.okRaw++;
      }
    }
    /* 坏例：过了的要数出来（那是语法收得太宽）。它们的字节/记号/时间也算进吞吐 ——
       那一趟活是真干了。 */
    for (const f of bad) {
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
      if (toks !== null) row.tokens += toks.length;
      if (tree !== null && !diags.hasErrors()) {
        row.badOk++;
        row.nodes += countNodes(tree);
      }
    }
  }
  rows.push(row);
}

// ---- 印。两种排版：默认是给终端看的定宽表，`--md` 是给 DESIGN.md 用的
const head = ['语言', '状态', '产生式', '终结符', '冲突', '冷建表', '热装表', '文件', '过', '坏例', '字节', '记号', '节点', '解析', 'MB/s', '万记号/s'];
const body = rows.map((r) => [
  r.name,
  `${r.states}`,
  `${r.rules}`,
  `${r.terms}`,
  `${r.conflicts}`,
  ms(r.coldMs),
  r.hit ? ms(r.warmMs) : `MISS ${ms(r.warmMs)}`,
  `${r.files}`,
  /* `过`：配了预处理的语言印 `预处理后/原样` —— 两个数都要说得出来，不然"这门语言自己
     不做预处理"那句话与这一栏就会走散。 */
  r.note !== undefined ? '-' : (r.okRaw === r.ok ? `${r.ok}` : `${r.ok}/${r.okRaw}`),
  r.badOk > 0 ? `${r.bad}+${r.badOk}` : `${r.bad}`,
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
  /* 预处理自己炸了的那些**退回原文**读了 —— 数目要印出来，不然这一栏看起来像"全预处理过了"。 */
  if (r.ppFail > 0) process.stdout.write(`\n${r.name}: 预处理炸了 ${r.ppFail} 份（那些退回原文再读）\n`);
}
for (const n of notes) process.stdout.write(`\nskip ${n}\n`);

if (showFail) {
  for (const r of rows) {
    if (r.fails.length === 0) continue;
    process.stdout.write(`\n${r.name} 没过的 ${r.fails.length} 个（印头 ${FAIL_SHOWN} 条）：\n`);
    for (const f of r.fails.slice(0, FAIL_SHOWN)) process.stdout.write(`  ${f}\n`);
    /* **再按错的形状归一次堆**（第一百三十八片）：头几条只告诉你「有哪几份没过」，
     * 而下一刀该往哪儿切要看**哪一族最多**。归一的办法是把消息里那几样会变的东西
     * （文件名、具体的记号、期待表）擦掉，只留形状 —— 于是「同一个洞」的几十份
     * 会落在同一行上。量出来的例子：cpp 的 269 份里 GLR 爆栈那一族占多少、
     * 「unexpected X」那一族占多少，一眼就分得开。 */
    const fam = new Map();
    for (const f of r.fails) {
      const msg = f.slice(f.indexOf(': ') + 2);
      const key = msg
        .replace(/'[^']*'/g, "'…'")
        .replace(/"[^"]*"/g, '"…"')
        .replace(/expected .*/, 'expected …')
        .replace(/\(> \d+\)/, '(> N)')
        .trim();
      fam.set(key, (fam.get(key) ?? 0) + 1);
    }
    const top = [...fam.entries()].sort((a, b) => b[1] - a[1]);
    process.stdout.write(`  —— 按形状归堆（${fam.size} 族）：\n`);
    for (const [k, n] of top.slice(0, 8)) {
      process.stdout.write(`  ${String(n).padStart(4)}  ${k}\n`);
    }
  }
} else if (rows.some((r) => r.fails.length > 0)) {
  process.stdout.write('\n（有没过的文件；加 --fail 看头几条）\n');
}
