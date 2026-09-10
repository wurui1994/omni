// src/core/lang/asy.js —— asy 前端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/wat.js、lang/sx.js 同一条规矩：**不 import cli.js**（那是"能独立编译成一个
// 动态库"的硬条件），要的宿主服务由入参给。asy 那一摊比 wat / sx 大得多（约 350 行：
// 语法表 / 词法 / 内建绑定表、AST 缓存、模块解析、asyText、compileAsy），所以**一片一片搬**，
// 每一片搬完都能跑；这一份先立起来，装的是 AST 缓存的紧凑格式。
//
// 产物缓存那几格（jsCache* / exeCache* / srcStamp）不跟着搬 —— 那是驱动层的策略，
// `.asy` 只是它现在唯一的用户。它与前端之间只有一处交接：前端读过哪些文件（依赖清单），
// 那一格要变成 compile 的返回值，而不是让驱动去读前端的模块级变量。

import { env } from '../host/native.js';
import { OmniError } from '../source/diag.js';
import { join, resolve } from '../host/path.js';
import { readText, writeText, exists, mkdirAll, mtimeMs, fileSize, installDir, cwd } from '../host/native.js';
import { cacheRoot } from '../host/cache.js';
import { hash16 } from '../host/hash.js';
import { readGrammar } from '../glr/grammar.js';
import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { parseAsyBuiltins } from '../frontend-asy/types.js';
import { SourceFile } from '../source/diag.js';

/* cli.js 那个 loadGrammar 是"读表 + 印一行"，而这一份不许伸手去拿 cli 的东西 ——
   表还是同一个 loadGrammarTable（缓存就在它里面），只是印那一行走注入进来的 log。 */
function loadGrammarWith(path, log) {
  const { g, tb, hit, cachePath } = loadGrammarTable(path);
  if (hit) log(`grammar ${g.name}  ${tb.states.length} states, cache hit ${cachePath}`);
  else {
    log(`grammar ${g.name}  ${tb.states.length} states, ${tb.conflicts.length} conflicts left to GLR`);
    log(`grammar ${g.name}  table cached at ${cachePath}`);
  }
  return tb;
}



/**
 * 解析树的**紧凑格式**（第七十四刀）。量出来的：asy_builtins 那份树存成 JSON 是 12.0MB，
 * 用我们自己的 JSON 读器读回来 415ms，外加 184ms GC 与 109ms 读文件 —— 一趟 1.9s 里
 * 最大的一块，而且每个例子都得付一遍（树是**库**的，例子只是引它）。
 *
 * 树的形状只有三种（glrParse 出来的就是 S 表达式，见 glr/driver.js:114-130）：
 *   atom:   `{kind:'atom',   value, span:{start,end}}`
 *   string: `{kind:'string', value, raw, span:{start,end}}`
 *   list:   `{kind:'list',   items:[…], span:{start,end}}`
 * 所以不必走通用 JSON —— 前序一遍，长度显式写在前面，读的时候一遍扫过去，不用转义：
 *   `a` start `,` end `,` 值长 `:` 值
 *   `s` start `,` end `,` 值长 `,` 原文长 `:` 值 原文
 *   `l` start `,` end `,` 个数 `;` 子节点…
 * 形状认不出来（以后往节点上加了字段）就回 null，那一份**不进缓存**，行为一字不变。
 */
export function astPack(t, log) {
  const out = [];
  // 存不下来时说清是**哪一种形状**存不下来（`OMNI_ASY_PACKDBG=1`）：这一格一 null，
  // 整个单元的接口索引就不写，而从外面看只是"这个库还是从源码走"，量不出原因。
  const nope = (why, x) => {
    if (env('OMNI_ASY_PACKDBG') === '1') {
      log(`asy 打包不了 ${why} kind=${x === null || typeof x !== 'object' ? String(x) : x.kind} keys=${x === null || typeof x !== 'object' ? '' : Object.keys(x).join(',')}`);
    }
    return false;
  };
  const walk = (x) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return nope('不是节点', x);
    const sp = x.span;
    if (sp === null || sp === undefined || typeof sp !== 'object') return nope('没有 span', x);
    for (const k of Object.keys(sp)) {
      if (k !== 'start' && k !== 'end' && k !== 'file') return nope(`span 多一格 ${k}`, x);
    }
    if (!Number.isInteger(sp.start) || !Number.isInteger(sp.end)) return nope('span 不是整数', x);
    const ks = Object.keys(x);
    if (x.kind === 'atom') {
      if (ks.length !== 3 || typeof x.value !== 'string') return nope('atom 形状不对', x);
      out.push(`a${sp.start},${sp.end},${x.value.length}:${x.value}`);
      return true;
    }
    if (x.kind === 'string') {
      if (ks.length !== 4 || typeof x.value !== 'string' || typeof x.raw !== 'string') return nope('string 形状不对', x);
      out.push(`s${sp.start},${sp.end},${x.value.length},${x.raw.length}:${x.value}${x.raw}`);
      return true;
    }
    if (x.kind === 'list') {
      if (ks.length !== 3 || !Array.isArray(x.items)) return nope('list 形状不对', x);
      out.push(`l${sp.start},${sp.end},${x.items.length};`);
      for (const y of x.items) {
        if (!walk(y)) return false;
      }
      return true;
    }
    return nope('认不出的 kind', x);
  };
  return walk(t) ? out.join('') : null;
}

/** 上面那一份读回来。`file` 直接挂在 span 上，所以不用再走一遍"重新挂 file"。 */
export function astUnpack(s, file) {
  let i = 0;
  const num = (stop) => {
    let n = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === stop) { i++; return n; }
      if (c < 48 || c > 57) throw new OmniError(`ast 缓存坏了：第 ${i} 个字符不是数字`);
      n = n * 10 + (c - 48);
      i++;
    }
    throw new OmniError('ast 缓存坏了：数没读完就到末尾了');
  };
  const node = () => {
    const t = s.charCodeAt(i);
    i++;
    const start = num(44);          // ','
    const end = num(44);
    if (t === 97) {                 // 'a'
      const len = num(58);          // ':'
      const value = s.slice(i, i + len);
      i += len;
      return { kind: 'atom', value: value, span: { start: start, end: end, file: file } };
    }
    if (t === 115) {                // 's'
      const vlen = num(44);
      const rlen = num(58);
      const value = s.slice(i, i + vlen);
      i += vlen;
      const raw = s.slice(i, i + rlen);
      i += rlen;
      return {
        kind: 'string', value: value, raw: raw, span: { start: start, end: end, file: file },
      };
    }
    if (t !== 108) throw new OmniError(`ast 缓存坏了：第 ${i - 1} 个字符不是 a/s/l`);
    const n = num(59);              // ';'
    const items = [];
    for (let k = 0; k < n; k++) items.push(node());
    return { kind: 'list', items: items, span: { start: start, end: end, file: file } };
  };
  const t = node();
  if (i !== s.length) throw new OmniError('ast 缓存坏了：末尾还有多余的东西');
  return t;
}

/**
 * asy 前端的零件：语法表 + 词法 + 内建绑定表。**文件 IO 与表加载都在这里**，
 * 降级器只拿解析好的东西 —— 整份文件的编译（asyText）与 REPL（repl.js 的 AsyLang）
 * 共用这一份，所以"从哪里找模块"这类规则不会有两份实现。
 */
export function asyFrontEnd(api) {
  /* 宿主服务从这一格拿，不许伸手去 import cli.js。
     inpPath 是驱动那边"印记"格式（路径:改动时间:字节数:h内容哈希）的读法 —— 搬这一块的时候
     才发现前端在读它，那是一处层次串门：AST 缓存的键沿用了产物缓存的印记格式。
     先按服务注进来（行为不变），把这份印记格式收回驱动那一侧是另一刀。 */
  const log = api.log;
  const inpPath = api.inpPath;
  const inpOk = api.inpOk;
  const inpField = api.inpField;
  const gpath = join(installDir(), '..', 'frontend-asy', 'asy.grammar');
  if (!exists(gpath)) throw new OmniError(`找不到 asy 语法文件：${gpath}`);
  const tb = loadGrammarWith(gpath, log);
  // 内建函数的绑定表是**数据**，跟语法表一个路子。数学不是 asy 的语法
  //（asy 自己那边也是 builtin.cc 里一张表）。
  const btab = join(installDir(), '..', 'frontend-asy', 'builtins.tab');
  if (!exists(btab)) throw new OmniError(`找不到 asy 内建绑定表：${btab}`);
  const builtins = parseAsyBuiltins(readText(btab));
  log(`asy builtins   ${builtins.size} 条绑定`);
  // ---- 解析缓存（第七十二刀）----
  // 量出来的：一个只带 prelude 的文件跑 836ms，里面 glrParse 120ms + lexText 59ms +
  // 建树 55ms 是最大的一块（node --cpu-prof），而 prelude 与 base/ 那几十个文件每次跑
  // 都**一模一样**。所以按「语法表 + 源文本」的哈希把树存到盘上，命中就 JSON.parse 回来。
  // 键里带语法表的哈希：语法一改，缓存整片失效。`OMNI_NO_ASTCACHE=1` 关掉它（对照用）。
  // span 里的 `file` 是个带全文与行表的对象，不进 JSON —— 读回来再挂上（astReattach）。
  const gkey = hash16(readText(gpath));
  const astDir = env('OMNI_NO_ASTCACHE') === '1' ? null : join(cacheRoot(), 'asy-ast');
  if (astDir !== null) mkdirAll(astDir);
  const parseText = (p, text, diags) => {
    const file = new SourceFile(p, text);
    // 键不哈希全文（量过：哈希 base 那几十个文件要 56ms）——用「路径 + 改动时间 + 字节数」，
    // 那三样一致就是同一份源码，而 stat 是常数时间。文本不是从盘上来的（REPL、内联）时
    // 退回哈希那条路。
    //
    // 改动时间与语法表的哈希**不在文件名里，在旁边那份 .stamp 里**（第七十四刀）：
    // 编进文件名的话每改一次源码就多出一条，asy_builtins 那一条 12MB，量过 .omni-cache/asy-ast
    // 就是这么攒到 1.3GB 的。现在一份源码在盘上**只占一条**，改了就原地盖掉。
    //
    // 文件名是**源文件的基名 + 一段路径哈希**，只换后缀：`plain.asy` -> `plain__<8 位>.ast`。
    // 全哈希的名字看不出在复用谁，所以基名留着。**一层平铺、不分子目录** —— 这份缓存是
    // 公用的：谁引到 `plain.asy` 都用同一格。
    // 路径那一段是必须的：只取基名时同名不同目录撞在一格上，两个入口轮流跑就互相盖
    // （从前的注释说"撞了就是印记不一致，退化成不命中"，那是**错的** —— 见下面 same 那一行）。
    // 不是从盘上来的文本（REPL、内联）没有名字，按全文哈希起名。
    let base = '';
    let inline = false;
    if (astDir !== null) {
      if (exists(p)) {
        const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        const nm = cut < 0 ? p : p.slice(cut + 1);
        const dot = nm.lastIndexOf('.');
        base = `${dot <= 0 ? nm : nm.slice(0, dot)}__${hash16(p).slice(0, 8)}`;
      } else {
        inline = true;
        base = `_inline-${hash16(text)}`;
      }
    }
    const cpath = base === '' ? '' : join(astDir, `${base}.ast`);
    const spath = base === '' ? '' : join(astDir, `${base}.stamp`);
    // 这一趟的文本已经在手上，把这份内容的身份记进备忘（下面真要哈希时不用再读一遍文件）
    const seed = () => {
      const m = mtimeMs(p);
      const n = fileSize(p);
      const had = srcIdMemo.get(p);
      if (had === undefined || had.mtime !== m || had.len !== n) {
        srcIdMemo.set(p, { mtime: m, len: n, hash: hash16(text) });
      }
    };
    if (cpath !== '' && exists(spath) && exists(cpath)) {
      const fs = readText(spath).split('|');
      // 印记的身份是**内容哈希**（inline 那种没有文件，名字里已经带着哈希）：touch 一下、
      // 重新 checkout 一遍都不该让这份树作废。改动时间与字节数只是省一次读的预检 ——
      // 两样对得上就直接命中，对不上才真去哈希一遍（inpOk）。
      //
      // **先核路径**：这一格的文件名只是基名，同名不同目录会撞到一起，而 `inpOk` stat 的是
      // **印记里记着的**那个路径，不是这一趟要的这个 —— 于是撞了反而"命中"。
      // 量到的样子：`omni run /tmp/tri2.asy` 解析出来的是 `/tmp/asyfp/tri2.asy` 的树，
      // 整趟前端都在编另一个程序，输出是一份画图的 EPS（tri2.asy 里一句画图都没有）。
      const same = inline || inpPath(fs[1]) === p;
      const r = inline ? { ok: fs[1] === '-', cur: '-' } : inpOk(fs[1] === undefined ? '' : fs[1]);
      if (fs[0] === gkey && same && r.ok) {
        const t = astUnpack(readText(cpath), file);
        if (r.cur !== fs[1]) writeText(spath, `${gkey}|${r.cur}`);   // 刷新预检那两格
        log(`asy ast cache  ${p}`);
        return t;
      }
    }
    const toks = lexText(tb.grammar.lex, file, diags);
    diags.throwIfErrors();
    log(`asy lexer      ${p} -> ${toks.length} tokens`);
    const t = glrParse(tb, toks, diags);
    diags.throwIfErrors();
    if (cpath !== '') {
      const packed = astPack(t, log);
      // 形状认不出来就不缓存（见 astPack 的注释）。先写树再写印记：印记是"这一条成了"的凭据。
      if (packed !== null) {
        if (!inline) seed();
        writeText(cpath, packed);
        writeText(spath, `${gkey}|${inline ? '-' : inpField(p)}`);
      }
    }
    return t;
  };
  // 模块的找法是量出来的 —— asy 按**当前目录**找，不是按引它的那个文件所在的目录
  // （量过：`asy -noV sub/user.asy` 里的 `import mm;` 找不到 sub/mm.asy）。
  // 当前目录之后按 `ASYMPTOTE_DIR`（asy 自己的那个环境变量，冒号分隔）找，最后是
  // 我们自己的 src/lib/asy。**base/*.asy 不抄一份**：plain/graph 那一堆是 asy
  // 源码，要引的就是真的那些；我们只补 C++ 那一侧的内建面（lib/asy 里那一份）。
  const libDir = join(installDir(), '..', '..', 'lib', 'asy');
  const searchDirs = [];
  const envDir = env('ASYMPTOTE_DIR');
  if (envDir !== undefined && envDir !== '') {
    for (const d of envDir.split(':')) if (d !== '') searchDirs.push(d);
  }
  searchDirs.push(libDir);
  // 这一趟真的加载了哪些模块文件（按加载顺序）。产物缓存的依赖清单靠它。
  const seen = [];
  const paths = new Map();
  /**
   * 模块名 -> 它解析到的**真文件**，只 stat、不读不解析。
   *
   * 单独摘出来是必须的：产物名里带着这个路径的哈希（见 unitName），而问"这个库的产物
   * 还能用吗"（skipBody / 接口索引）发生在**加载之前** —— 那时候 `paths` 里还没有这一格，
   * 名字就会算成 `asy_builtins__<key 的哈希>`，与盘上那份 `asy_builtins__<路径的哈希>`
   * 对不上，于是每一格都报"没有 .aif"。量到的样子：13 份里只有 2 份走上索引。
   */
  const resolve = (name) => {
    const had = paths.get(name);
    if (had !== undefined) return had;
    // `collections.map` 这种带点的模块路径，文件是 `collections/map.asy`（量过 asy 也这样找）。
    // 先按原样找一遍：真有个叫 `a.b.asy` 的文件时那份赢，与不带点的写法同一条规矩。
    const cands = name.indexOf('.') < 0 ? [name] : [name, name.split('.').join('/')];
    for (const nm of cands) {
      const q = join(cwd(), `${nm}.asy`);
      if (exists(q)) { paths.set(name, q); return q; }
    }
    for (const d of searchDirs) {
      for (const nm of cands) {
        const q = join(d, `${nm}.asy`);
        if (exists(q)) { paths.set(name, q); return q; }
      }
    }
    return '';
  };
  const loader = (diags) => (name) => {
    const p = resolve(name);
    if (p === '' || !exists(p)) return null;
    log(`asy module    ${name} -> ${p}`);
    seen.push(p);
    return parseText(p, readText(p), diags);
  };
  return {
    parseText: parseText, loader: loader, builtins: builtins, libDir: libDir, seen: seen,
    paths: paths, resolve: resolve,
  };
}
