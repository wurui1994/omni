// Omni — 语法 -> LR 表的**带缓存**装载（ADR-0019 决策八第 1 步）
//
// 为什么要单独一处：构表在 GLSL 那份语法上量到 **559 ms**（`bench-simple` 那一趟里
// 前端合计 583 ms，其中 559 是它）。而 llvmpipe 编一整个片元变体是 1～20 ms ——
// 也就是说「构表」这一步自己就把「等效」两个字否掉了。
//
// 表本身是**内容寻址**缓存的：键是 `TABLE_FORMAT` + 语法文件的正文，所以
//   - 语法改一个字符，键就变，不会读到旧表
//   - 两个 checkout 之间共享同一份缓存也不会串
//
// `tableFromText` 出来的对象与 `buildTable` 的**逐字段相同**（`tests/glr` 那条轴拿
// `dumpTable` 逐字节比过），所以「命中缓存」与「现算」在语义上不是两条路。
//
// 这一处从 `cli.js` 的 `loadGrammar()` 里搬出来：那一份只有 CLI 自己用，而十四支
// GLSL 的门各自 `buildTable()` 一遍 —— 跑一趟全套等于白花 14 × 559 ms。

import { writeText, readText, exists, mkdirAll, rename } from '../host/native.js';
import { cacheRoot } from '../host/cache.js';
import { join } from '../host/path.js';
import { hash16 } from '../host/hash.js';
import { readSexpr } from '../sexpr/read.js';
import { Diagnostics, SourceFile } from '../source/diag.js';
import { readGrammar } from './grammar.js';
import { isYaccPath, yaccToGrammarText } from './yacc.js';
import { isEbnfPath, ebnfToGrammarText } from './ebnf.js';
import { buildTable, tableText, tableFromText, TABLE_FORMAT } from './table.js';

/**
 * 一份语法文件 -> `{ g, tb, hit }`。
 *
 * `hit` 是「这一趟有没有省掉构表」—— 门里拿它断言「第二趟必须命中」，不然缓存写坏了
 * 也看不出来（只会觉得慢）。
 *
 * `.y`（bison/yacc）先转成我们那份 `(grammar …)` 文本再往下走（glr/yacc.js）：于是
 * 缓存的键仍然是**转出来的**那段文本 —— `.y` 改一个字符键就变，而转换器改了口径
 * （`TABLE_FORMAT` 不动的那种改法）也不会读到旧表，因为文本本身就变了。
 *
 * 写盘是「先写临时文件再 rename」：几条腿并行跑时不会读到半截文件。
 */
export function loadGrammarTable(path) {
  const diags = new Diagnostics();
  const text = grammarTextOf(path, diags);
  diags.throwIfErrors();
  const g = readGrammar(readSexpr(new SourceFile(sourceLabel(path), text), diags), diags);
  diags.throwIfErrors();
  const dir = join(cacheRoot(), 'glr', hash16(`${TABLE_FORMAT}|${text}`));
  const cpath = join(dir, 'table.txt');
  if (exists(cpath)) {
    const tb = tableFromText(readText(cpath), g);
    if (tb !== null) return { g, tb, hit: true, cachePath: cpath };
  }
  const tb = buildTable(g);
  mkdirAll(dir);
  /* 暂存文件与最终目录**同一个父目录**，rename 才是原子的（跨卷 rename 会退化成拷贝）。 */
  const tmp = join(dir, `table.txt.${hash16(path)}`);
  writeText(tmp, tableText(tb));
  rename(tmp, cpath);
  return { g, tb, hit: false, cachePath: cpath };
}

/**
 * 一条路径 -> `(grammar …)` 的**文本**。`.y` 与 `.ebnf` 走各自的转换器，别的照原样读。
 *
 * 单独摆出来是给 `omni glr y` / `omni glr ebnf` 用的：那两条命令印的就是这段文本，
 * 于是「印出来的」与「建表用的」是同一份代码，不是同一份约定。
 */
export function grammarTextOf(path, diags) {
  const raw = readText(path);
  if (isYaccPath(path)) {
    const text = yaccToGrammarText(new SourceFile(path, raw), diags);
    return text === null ? '' : text;
  }
  if (isEbnfPath(path)) {
    const text = ebnfToGrammarText(new SourceFile(path, raw), diags);
    return text === null ? '' : text;
  }
  return withExtends(path, raw, diags);
}

/**
 * **方言：`(extends "别的.grammar")`** —— 继承一份语法，再加几条产生式。
 *
 * 这一格是 gsl-shell 逼出来的：它与 lua 用同一个 `.lua`，源码几乎同形，差的是一个
 * 短 lambda（`|x| expr`）。之前只有两条路，两条都不好：把那条产生式加进 `lua.grammar`
 * 是让 lua 接受它自己没有的写法（**假接受比报错坏**），另开一份语法要把 lua 那 113 条
 * 抄一遍（**抄两份就是两套语义**）。所以给 DSL 加这一格。
 *
 * 落在**文本**这一层而不是对象这一层，理由是缓存：`loadGrammarTable` 的键就是这段文本，
 * 拼进基准那份之后，**改 `lua.grammar` 会让方言的表自动失效**。落在对象层就得再想一套
 * "键里也要算上基准文件"的办法 —— 那是第二处会忘的地方。
 *
 * 合并规矩（都简单到不用记）：
 *   * 基准那份的**全部条目**先放，本份的接在后面；
 *   * 同名 `(rule N …)` 是**追加产生式**（`readGrammar` 本来就允许一个非终结符出现多次），
 *     所以方言只写"多出来的那几条"；
 *   * `(start N)` 后来的盖过先来的 —— 方言想换起始符号就自己写一条；
 *   * `(lex …)` **叠**：方言写的条目接在基准那份的后面，合出来仍只有一个 `(lex …)` form
 *     （见下面 `mergeLex` —— `readGrammar` 那句 "at most one (lex ...)" 因此不用改）。
 */
function withExtends(path, text, diags) {
  const m = /\(extends\s+"([^"]+)"\)/.exec(text);
  if (m === null) return text;
  const basePath = join(dirOf(path), m[1]);
  if (!exists(basePath)) {
    diags.error(null, `(extends "${m[1]}")：找不到 ${basePath}`);
    return text;
  }
  const baseInner = innerItems(grammarTextOf(basePath, diags), basePath, diags);
  const mine = innerItems(text.replace(m[0], ''), path, diags);
  const name = grammarName(text);
  const [base2, mine2] = mergeLex(baseInner, mine);
  return `(grammar ${name}\n;; ==== 继承自 ${m[1]}（omni glr 里的"方言"，见 load.js 的 withExtends）====\n`
    + `${base2}\n;; ==== 本份多出来的 ====\n${mine2}\n)\n`;
}

/**
 * **词法也能叠**：方言写自己的 `(lex …)`，里头的条目**接在基准那份的后面**，
 * 合出来仍然只有一个 `(lex …)` form（`readGrammar` 那句 "at most one (lex ...)" 因此不用改）。
 *
 * 接在后面而不是前面，是因为 `lexText` 取**最长匹配**（同长才按声明顺序）：
 * 方言加的形状总比基准那条长（`1i` 比 `1` 长、`say` 是新词），所以位置不影响谁赢。
 * 反过来若把方言放前面，基准那条同长的规则就会被抢，改的东西比说的多。
 *
 * 这一格是 LuaJIT 的虚数字面量 `1i` 逼出来的：gsl-shell 自带的 LuaJIT 带 FFI，
 * `1i` 是**记号**那一层的事（`lj_strscan.c:421-425`），产生式加不出来。
 */
function mergeLex(baseInner, mine) {
  const d = formAt(mine, 'lex');
  if (d === null) return [baseInner, mine];                 // 方言没写词法：原样
  const mineOut = mine.slice(0, d.start) + mine.slice(d.end);
  const b = formAt(baseInner, 'lex');
  if (b === null) return [baseInner, mine];                 // 基准没有词法段：方言那份就是唯一一份
  const merged = `${baseInner.slice(0, b.end - 1)}\n`
    + `    ;; ==== 方言加的词法（接在后面：词法取最长匹配，所以顺序不决定谁赢）====\n`
    + `${d.inner}\n  )${baseInner.slice(b.end)}`;
  return [merged, mineOut];
}

/**
 * 文本里第一个 `(HEAD …)` form 的位置：`{start, end, inner}`
 * （`text.slice(start, end)` 就是整个 form，`inner` 是括号里 HEAD 之后那一截）。
 * 自己数括号是因为这一层**刻意还没解析**（拼的是文本，见 `withExtends` 的理由），
 * 所以字符串与 `;;` 注释里的括号要跳过 —— 词法段里正好有 `"("` 与 `")"` 这两条。
 */
function formAt(text, head) {
  const at = text.indexOf(`(${head}`);
  if (at < 0) return null;
  let i = at + 1 + head.length;
  if (i < text.length && !/[\s()]/.test(text[i])) return null;   // `(lexer` 不算 `(lex`
  const inner0 = i;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"') {                       // 串：里头的括号不算
      i += 1;
      while (i < text.length && text[i] !== '"') i += (text[i] === '\\' ? 2 : 1);
    } else if (c === ';' && text[i + 1] === ';') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    } else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null;
  return { start: at, end: i, inner: text.slice(inner0, i - 1) };
}

/** `(grammar NAME …)` 里 NAME 后面那一截（不含最外层括号与名字）。 */
function innerItems(text, path, diags) {
  const i = text.indexOf('(grammar');
  if (i < 0) { diags.error(null, `${path}: 不是一份 (grammar …)`); return ''; }
  let j = i + '(grammar'.length;
  while (j < text.length && /\s/.test(text[j])) j += 1;
  while (j < text.length && !/[\s()]/.test(text[j])) j += 1;   // 跳过名字
  const last = text.lastIndexOf(')');
  if (last < j) { diags.error(null, `${path}: (grammar …) 没收口`); return ''; }
  if (text.slice(last + 1).trim() !== '') {
    diags.error(null, `${path}: (grammar …) 收口之后还有别的东西 —— 方言拼接要求一份文件只有一个 form`);
    return '';
  }
  return text.slice(j, last);
}

/** `(grammar NAME …)` 的 NAME。 */
function grammarName(text) {
  const m = /\(grammar\s+([^\s()]+)/.exec(text);
  return m === null ? '?' : m[1];
}

/** 一条路径的目录（不引 `node:path` —— 这一份要能跟着编译器被降级）。 */
function dirOf(p) {
  const i = String(p).lastIndexOf('/');
  return i < 0 ? '.' : String(p).slice(0, i);
}

/** 转出来的那份文本报错时印什么路径 —— 别让 caret 指着 `.y` 的行号却是转换后的正文。 */
function sourceLabel(path) {
  return isYaccPath(path) || isEbnfPath(path) ? `${path} (转成 .grammar 之后)` : path;
}
