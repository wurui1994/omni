// Omni stage0 — 数据驱动的词法器（ADR-0014 决策 2）
//
// 为什么不是正则：封闭 ABI（ADR-0011 决策 2）里只有 `js_re_test/match/split/replace`，而且
// 都是**从字面量降下来的** —— `new RegExp(str)` 不在表里。语法文件里读进来的模式是运行期
// 才知道的字符串，用正则就等于要求原生构建带一个正则引擎。量过一次代价（ADR-0013 的口径：
// 不引入 GC、不引入不可预测的分配），结论是不值得：真实语言的词法用不着回溯。
//
// 于是模式语言是一小把**字符类原语**，贪心、不回溯 —— 就是手写词法器的那种写法，只是写成了
// 数据。这不是能力上的退让：flex 生成的 DFA 也不回溯。
//
//   (lex
//     (skip space)                            ;; 要跳过的东西，可以有多条
//     (comment ";;" (* (not "\n")))           ;; 行注释：也只是"要跳过的模式"
//     (block-comment "/*" "*/")               ;; 不嵌套；写 (block-comment "(;" ";)" nest) 才嵌套
//     (token NUM (+ digit) (? "." (* digit)))  ;; 一条 token 规则，若干项顺序相连
//     (token ID (or alpha "_") (* (or alnum "_")))
//     (string STRING "\"")                    ;; 带反斜杠转义的引号串，出 string 节点
//     (keyword ID "if" "else" "while")        ;; ID 命中这些字面量就改判成 "if" 之类
//     (keyword ID LIT "true" "false")         ;; 多写一个名字 = 改判成那个 token 类型
//     (punct SELFOP "+=" "-=")                ;; 字面量，但出指定的 token 类型
//     (fuse ID "operator" "+" "-" "init")     ;; 「一个词 + 一个算符名」粘成一个 token
//     (stop "#!eof" line-start)               ;; 扫到这儿就收工 —— 后面那些字不是源码
//     (auto-semi ";" after NAME NUM ")" "]")  ;; 跨过换行时按上一个记号补一格（go 的 ASI）
//     (op "+" "-" "->" "(" ")"))              ;; = punct，类型就是字面量自己
//
// **「看上一个记号」那两格**（`(not-after …)` 与 `auto-semi`）是同一件事的两种用法：
// 词法器手上唯一的上下文就是"上一个交出去的记号是什么"。它不是状态机（没有起始条件、
// 没有栈），只有这一格，而这一格恰好把两族真问题解决掉：
//
//   - **正则字面量 vs 除号**（awk / js / perl）：`/re/` 与 `a / b` 在字符层一模一样，
//     分开它们靠的是"前一个记号是不是一个操作数"。写成
//     `(token ERE (not-after NAME NUMBER STRING ")" "]") "/" … "/")` —— 于是这条规则
//     在"前面刚出现过操作数"的时候根本不参赛，除号自然赢。
//   - **自动分号**（go / vlang）：换行在特定记号之后**就是**一个分号。
//     `(auto-semi ";" after NAME NUMBER ")" "}" "return")`，跨过换行时补一格。
//     文件末尾也补（Go 的规矩），不然最后一条语句收不了尾。
//
// 两者都**只看类型、不回头改已经交出去的记号**，所以词法这一层仍然是一趟扫完、不回溯。
//
// `stop` 是给「文件后半截不是源码」那一族留的位置。Chez 的 `#!eof` 就是它（参考树里
// 16 个 .ss 用了：后面接的是散文与 shell 命令，连词法都切不动），Perl / Ruby 的
// `__END__` 同形。这件事**只能在词法层**做：语法层收不到"剩下的字不许当记号"这句话，
// 而块注释那一格也不行 —— 它要求有个收尾标记，这里没有。
//
// `fuse` 是给 flex 的**起始条件**留的位置。camp.l 里 `operator` 会 `BEGIN opname`，把后面那个
// 算符读掉，回一个名字叫 `operator +` 的 ID —— 于是 asymptote 的语法层根本不知道有算符重载
// 这回事，`operator +` 在能写名字的地方都能写。我们没有起始条件（那要求词法器有状态机），
// 但这个模式只需要"前缀词 + 跨过空白 + 一个候选项"，够小，就照这个形状给一条规则。
// 出来的 token 文本是规范化的 `前缀 空格 候选项`，跟 asymptote 内部的符号名一致。
// 只跨空白，不跨注释：`operator /*x*/ +` 不认 —— 真实代码里没有，多出来的状态不值得。
//
// 项的词汇表：
//   字符类：space nl digit alpha alnum hex any
//   "字面量"           照原样比
//   (set "abc")        属于这几个字符之一
//   (not "abc")        不属于（但必须有一个字符）
//   (seq A B ...)      顺序，主要给 (or ...) 的分支用
//   (or A B ...)       挨个试，第一个成的算
//   (* A ...) (+ A ...) (? A ...)   贪心重复
//
// 规矩照 flex：**最长匹配优先，长度相同则声明在前的优先**。算符也在这场比里，所以 `->`
// 自然赢过 `-`，不用另写一层。
//
// 出来的东西正好是 driver.js 要的：`{type, node, span}[]`，type 对上 grammar.js 的终结符名
// （字面量终结符的名字是 `JSON.stringify(文本)`，两边共用 litName 的口径）。

import { isList, isAtom, isStr, head } from '../sexpr/read.js';
import { span as mkSpan } from '../source/diag.js';

/** 字面量终结符的内部名。grammar.js 也用这一个 —— 两边的口径必须是同一份代码，不是同一份约定 */
export const litName = (s) => JSON.stringify(s);

const CLASSES = new Set(['space', 'nl', 'digit', 'alpha', 'alnum', 'hex', 'any']);
const REPEATS = new Set(['*', '+', '?']);

/** 单个字符属不属于某个类。用码点比而不是字符串大小比 —— 后者不在封闭 ABI 里。 */
function inClass(name, cc) {
  if (name === 'any') return true;
  if (name === 'nl') return cc === 10;
  if (name === 'space') return cc === 32 || cc === 9 || cc === 10 || cc === 13;
  if (name === 'digit') return cc >= 48 && cc <= 57;
  if (name === 'alpha') return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
  if (name === 'alnum') return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
  if (name === 'hex') return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 70) || (cc >= 97 && cc <= 102);
  return false;
}

// ---- 匹配 ------------------------------------------------------------------
// 约定：返回匹配结束的位置，`-1` 表示不匹配。贪心且不回溯 —— `(+ digit) (? "." (* digit))`
// 这类写法没问题，但 `(* any) ";"` 这种"先吞光再要求后缀"的写法必然失败，那是模式写错了。

/** 一串项顺序相连；`from` 是起始下标（列表的第 0 项是 head，要跳掉） */
function matchSeq(items, from, src, pos) {
  let p = pos;
  for (let i = from; i < items.length; i++) {
    p = matchTerm(items[i], src, p);
    if (p < 0) return -1;
  }
  return p;
}

function matchTerm(t, src, pos) {
  if (isStr(t)) return src.startsWith(t.value, pos) ? pos + t.value.length : -1;
  if (isAtom(t)) {
    if (pos >= src.length) return -1;
    return inClass(t.value, src.charCodeAt(pos)) ? pos + 1 : -1;
  }
  const h = head(t);
  if (h === 'set' || h === 'not') {
    if (pos >= src.length) return -1;
    const hit = t.items[1].value.includes(src.slice(pos, pos + 1));
    return hit === (h === 'set') ? pos + 1 : -1;
  }
  if (h === 'seq') return matchSeq(t.items, 1, src, pos);
  if (h === 'or') {
    for (let i = 1; i < t.items.length; i++) {
      const e = matchTerm(t.items[i], src, pos);
      if (e >= 0) return e;
    }
    return -1;
  }
  // 重复。`e === p` 的判断是防死循环：`(* (? digit))` 里内层能匹配零个字符。
  let p = pos;
  let n = 0;
  for (;;) {
    const e = matchSeq(t.items, 1, src, p);
    if (e < 0 || e === p) break;
    p = e;
    n++;
    if (h === '?') break;
  }
  if (h === '+' && n === 0) return -1;
  return p;
}

// ---- 规格的读入 ------------------------------------------------------------

/** 标识符字符（含下划线）。fuse 的词边界判断要用，别跟 inClass('alnum') 混起来。 */
const isWordChar = (cc) => inClass('alnum', cc) || cc === 95;

/**
 * `(fuse TYPE "前缀" 候选...)`：前缀词 + 跨过空白 + 最长的那个候选项。
 * 返回 `{end, value}`，`end < 0` 表示不匹配 —— 那时前缀词会照常被 token 规则收成普通 ID。
 */
function matchFuse(rule, src, pos) {
  const miss = { end: -1, value: null };
  if (!src.startsWith(rule.text, pos)) return miss;
  let p = pos + rule.text.length;
  // 前缀词自己的词边界：`operatorx` 不是 `operator` + `x`
  if (p < src.length && isWordChar(src.charCodeAt(p))) return miss;
  while (p < src.length && inClass('space', src.charCodeAt(p))) p++;
  let bestAlt = null;
  let bestEnd = -1;
  for (const a of rule.alts) {
    if (!src.startsWith(a, p)) continue;
    const e = p + a.length;
    // `init` 这种字母候选项也要词边界，否则 `operator initial` 会被咬掉一半
    if (isWordChar(a.charCodeAt(a.length - 1)) && e < src.length && isWordChar(src.charCodeAt(e))) continue;
    if (e > bestEnd) { bestEnd = e; bestAlt = a; }
  }
  if (bestAlt === null) return miss;
  return { end: bestEnd, value: `${rule.text} ${bestAlt}` };
}

/** 项的合法性当场查掉，别留到运行期才报"这个 head 我不认识" */
function checkTerm(t, diags) {
  if (isStr(t)) return;
  if (isAtom(t)) {
    if (!CLASSES.has(t.value)) diags.error(t.span, `unknown character class '${t.value}'`);
    return;
  }
  if (!isList(t) || t.items.length === 0) {
    diags.error(t === null || t === undefined ? null : t.span, 'a pattern term must be a class name, a string, or a form');
    return;
  }
  const h = head(t);
  if (h === 'set' || h === 'not') {
    if (!isStr(t.items[1]) || t.items.length !== 2) diags.error(t.span, `(${h} "chars") takes exactly one string`);
    return;
  }
  if (h === 'seq' || h === 'or' || REPEATS.has(h)) {
    if (t.items.length < 2) diags.error(t.span, `(${h} ...) needs at least one term`);
    for (const x of t.items.slice(1)) checkTerm(x, diags);
    return;
  }
  diags.error(t.span, `unknown pattern form '${h === null ? '?' : h}'`);
}

/**
 * 一条规则前面那格可选的**上下文条件**：`(after T…)` 或 `(not-after T…)`。
 * 答 `{cond, from}` —— `from` 是"条件之后从哪一项接着读"。
 *
 * 条件里的 T 既可以是记号类型名（`NAME`），也可以是字面量（`")"`）—— 后者按 litName
 * 折成内部名，与规则那边的口径同一份代码。
 */
function readCond(items, from, diags) {
  const t = items[from];
  const h = head(t);
  if (h !== 'after' && h !== 'not-after') return { cond: null, from };
  const types = new Set();
  for (const x of t.items.slice(1)) {
    if (isAtom(x)) types.add(x.value);
    else if (isStr(x)) types.add(litName(x.value));
    else diags.error(x === null || x === undefined ? t.span : x.span, `(${h} T...) takes token names or string literals`);
  }
  if (types.size === 0) diags.error(t.span, `(${h} T...) needs at least one token type`);
  return { cond: { neg: h === 'not-after', types }, from: from + 1 };
}

/** 上一个交出去的记号（可能没有）满不满足这条规则的条件。 */
function condOk(cond, prevType) {
  if (cond === null) return true;
  const hit = prevType !== null && cond.types.has(prevType);
  return cond.neg ? !hit : hit;
}

/**
 * 读 `(lex ...)`。返回 `{skips, blocks, rules, keywords, stops, autoSemi}`：
 *   skips    : 要跳过的模式（项数组），来自 skip / comment
 *   blocks   : [{open, close, nest}] 块注释
 *   rules    : [{kind:'token'|'string'|'op'|'fuse', type, terms|quote|text, cond, span}] 按声明顺序
 *   keywords : Map<tokenType, Set<text>>
 *   stops    : 扫到就收工的那几段文本（`#!eof` 一族）
 *   autoSemi : `{type, text, after:Set}` 或 null —— 跨过换行时补的那一格（go 的 ASI）
 */
export function readLexSpec(node, diags) {
  const skips = [];
  const blocks = [];
  const rules = [];
  const keywords = new Map();
  const stops = [];
  let autoSemi = null;
  if (head(node) !== 'lex') {
    diags.error(node === null || node === undefined ? null : node.span, 'a lexer spec must be a (lex ...) form');
    return null;
  }
  for (const it of node.items.slice(1)) {
    const h = head(it);
    if (h === 'skip' || h === 'comment') {
      if (it.items.length < 2) { diags.error(it.span, `(${h} ...) needs a pattern`); continue; }
      for (const x of it.items.slice(1)) checkTerm(x, diags);
      skips.push(it.items.slice(1));
      continue;
    }
    if (h === 'stop') {
      /* `(stop "#!eof")`：扫到这儿收工。**不是**跳过一段，是"后面那些字根本不是源码"。
       *
       * `line-start` 是"只有**顶格**写的才算"。Chez 需要这一格：`#!eof` 在它那儿是
       * 两件事 —— 顶层读到它就收工（后面接散文），而写在一个表里面它就是 eof 对象
       * 那格 datum（`'(#!eof #!bwp)`，s/cmacros.ss:2526）。两者靠"在不在第 1 列"分开：
       * 顶层的 datum 顶格起，表里面的一定缩进。这是一条**排版上的**约定，不是语义 ——
       * 所以要显式写出来，而不是让 `stop` 自己偷偷这么办。 */
      const flagAt = it.items.length - 1;
      const lineStart = isAtom(it.items[flagAt]) && it.items[flagAt].value === 'line-start';
      const upto = lineStart ? flagAt : it.items.length;
      for (let k = 1; k < upto; k++) {
        const s = it.items[k];
        if (isStr(s) && s.value.length > 0) stops.push({ text: s.value, lineStart });
        else diags.error(s === null || s === undefined ? it.span : s.span, '(stop "TEXT"... [line-start]) takes non-empty strings');
      }
      continue;
    }
    if (h === 'block-comment') {
      const open = it.items[1];
      const close = it.items[2];
      if (!isStr(open) || !isStr(close)) { diags.error(it.span, '(block-comment OPEN CLOSE) needs two strings'); continue; }
      const nest = isAtom(it.items[3]) && it.items[3].value === 'nest';
      if (it.items.length > 3 && !nest) diags.error(it.span, "the only flag after (block-comment OPEN CLOSE) is 'nest'");
      blocks.push({ open: open.value, close: close.value, nest });
      continue;
    }
    if (h === 'auto-semi') {
      /* `(auto-semi ";" after NAME NUMBER ")" "}")`：跨过换行时，若上一个记号在 after
       * 那张表里，就补一格。Go 的规范把它写成词法规则（"分号自动插入"），V 照抄。
       * 文件末尾也补一格 —— 不然最后一条语句收不了尾。 */
      const s = it.items[1];
      if (!isStr(s) || s.value.length === 0) { diags.error(it.span, '(auto-semi ";" after T...) needs the text to insert'); continue; }
      const kw = it.items[2];
      if (!isAtom(kw) || kw.value !== 'after') { diags.error(it.span, "(auto-semi \";\" after T...) needs the word 'after'"); continue; }
      const after = new Set();
      for (const x of it.items.slice(3)) {
        if (isAtom(x)) after.add(x.value);
        else if (isStr(x)) after.add(litName(x.value));
        else diags.error(x === null || x === undefined ? it.span : x.span, 'an auto-semi trigger must be a token name or a string literal');
      }
      if (after.size === 0) diags.error(it.span, '(auto-semi ...) needs at least one trigger token');
      if (autoSemi !== null) diags.error(it.span, 'a lexer spec may have at most one (auto-semi ...) form');
      autoSemi = { type: litName(s.value), text: s.value, after };
      continue;
    }
    if (h === 'token') {
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      if (nm === null || it.items.length < 3) { diags.error(it.span, '(token NAME PATTERN...) needs a name and a pattern'); continue; }
      const c = readCond(it.items, 2, diags);
      if (it.items.length <= c.from) { diags.error(it.span, '(token NAME PATTERN...) needs a pattern'); continue; }
      for (const x of it.items.slice(c.from)) checkTerm(x, diags);
      rules.push({ kind: 'token', type: nm, terms: it.items.slice(c.from), cond: c.cond, span: it.span });
      continue;
    }
    if (h === 'string') {
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      const c = readCond(it.items, 2, diags);
      const q = it.items[c.from];
      if (nm === null || !isStr(q) || q.value.length !== 1) { diags.error(it.span, '(string NAME "Q") needs a name and a one-character quote'); continue; }
      // `verbatim` = 反斜杠只对引号本身有效，别的位置就是一个普通反斜杠。asy 的双引号串
      // 就是这样（量过：`"a\tb"` 是 4 个字符 a \ t b），因为它要直接往 TeX 里塞。
      const verbatim = isAtom(it.items[c.from + 1]) && it.items[c.from + 1].value === 'verbatim';
      if (it.items.length > c.from + 1 && !verbatim) diags.error(it.span, "the only flag after (string NAME \"Q\") is 'verbatim'");
      rules.push({ kind: 'string', type: nm, quote: q.value, verbatim, cond: c.cond, span: it.span });
      continue;
    }
    if (h === 'keyword') {
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      if (nm === null) { diags.error(it.span, '(keyword TYPE w...) needs a token type'); continue; }
      // 第三项如果又是个名字，它就是**改判成什么**：camp.l 里 `true` 是 LIT 而不是关键字，
      // 于是写 `(keyword ID LIT "true" ...)`。省掉它就改判成字面量终结符（`"if"` 那种）。
      let from = 2;
      let to = null;
      if (isAtom(it.items[2])) { to = it.items[2].value; from = 3; }
      if (!keywords.has(nm)) keywords.set(nm, new Map());
      for (const w of it.items.slice(from)) {
        if (isStr(w)) keywords.get(nm).set(w.value, to === null ? litName(w.value) : to);
        else diags.error(w.span, 'a keyword must be a string');
      }
      continue;
    }
    if (h === 'fuse') {
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      const w = it.items[2];
      if (nm === null || !isStr(w) || w.value.length === 0 || it.items.length < 4) {
        diags.error(it.span, '(fuse TYPE "word" alt...) needs a token type, a prefix word and at least one alternative');
        continue;
      }
      const alts = [];
      for (const a of it.items.slice(3)) {
        if (isStr(a) && a.value.length > 0) alts.push(a.value);
        else diags.error(a === null || a === undefined ? it.span : a.span, 'a fused alternative must be a non-empty string');
      }
      rules.push({ kind: 'fuse', type: nm, text: w.value, alts, cond: null, span: it.span });
      continue;
    }
    if (h === 'op' || h === 'punct') {
      // `(op "+" ...)` 就是 `(punct ...)` 省掉类型的写法：类型是字面量终结符自己。
      let from = 1;
      let to = null;
      if (h === 'punct') {
        const t = it.items[1];
        to = isAtom(t) ? t.value : isStr(t) ? litName(t.value) : null;
        if (to === null) { diags.error(it.span, '(punct TYPE "s"...) needs a token type'); continue; }
        from = 2;
      }
      for (const o of it.items.slice(from)) {
        if (!isStr(o) || o.value.length === 0) { diags.error(o.span, 'an operator must be a non-empty string'); continue; }
        rules.push({ kind: 'op', type: to === null ? litName(o.value) : to, text: o.value, cond: null, span: o.span });
      }
      continue;
    }
    diags.error(it.span, `unknown lexer field '${h === null ? '?' : h}'`);
  }
  if (rules.length === 0) {
    diags.error(node.span, 'a lexer spec needs at least one (token ...), (string ...) or (op ...)');
    return null;
  }
  return { skips, blocks, rules, keywords, stops, autoSemi };
}

// ---- 扫描 ------------------------------------------------------------------

/**
 * 引号串。转义表跟 sexpr/read.js 保持一致（`\t \n \r \" \' \\` 与 `\xXX`），
 * 但这里**不**支持 `\u{...}`：那是 WAT 的方言，通用词法器不该替目标语言决定。
 * `verbatim` 的串只认 `\Q`（Q 就是那个引号），别处的反斜杠原样留着。
 * 返回 `{end, value}`，`end < 0` 表示没闭合。
 */
function scanString(src, pos, quote, verbatim = false) {
  let i = pos + 1;
  let out = '';
  while (i < src.length && src.slice(i, i + 1) !== quote) {
    if (src.slice(i, i + 1) !== '\\') { out += src.slice(i, i + 1); i++; continue; }
    const e = src.slice(i + 1, i + 2);
    if (verbatim) {
      // 只有 `\Q` 变成 Q；`\\` 是**一对**（两个反斜杠都留着，但它不再让后面那个引号变成
      // 转义），别的 `\x` 就是两个普通字符。三条都量过（asy，od -c）：
      //   "\\"        -> 2 字节 \ \      （串在第三个引号处正常收尾）
      //   "\""        -> 1 字节 "
      //   "a\\\"b"    -> 5 字节 a \ \ " b
      if (e === quote) { out += quote; i += 2; continue; }
      if (e === '\\') { out += '\\\\'; i += 2; continue; }
      out += '\\';
      i++;
      continue;
    }
    i += 2;
    // camp.l 的 `<cstring>` 那一段（:257-294）就是这张表。缺 `\b` 的代价是真的：
    // plain_strings.asy:252 的 `progress()` 转圈写的是 `write(stdout,'\b'+spinner[...])`，
    // `\b` 掉成字母 b 之后，genusthree/genustwo 的 EPS 里 `%%EOF` 后面多出一个 ` b`，
    // 判据按"多一个 token"记成结构不同。
    if (e === 'a') { out += '\u0007'; continue; }
    if (e === 'b') { out += '\b'; continue; }
    if (e === 'f') { out += '\f'; continue; }
    if (e === 'n') { out += '\n'; continue; }
    if (e === 'r') { out += '\r'; continue; }
    if (e === 't') { out += '\t'; continue; }
    if (e === 'v') { out += '\v'; continue; }
    if (e >= '0' && e <= '7') {
      // 八进制：一位、两位，或首位在 0..3 时的三位（camp.l:265-280 三条规则，长的先中）
      let oct = e;
      if ((src[i] ?? '') >= '0' && (src[i] ?? '') <= '7') {
        oct += src[i];
        i++;
        if (e <= '3' && (src[i] ?? '') >= '0' && (src[i] ?? '') <= '7') { oct += src[i]; i++; }
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
      continue;
    }
    if (e === 'x') {
      const cc = Number.parseInt(src.slice(i, i + 2), 16);
      if (Number.isInteger(cc)) { out += String.fromCharCode(cc); i += 2; continue; }
      out += 'x';
      continue;
    }
    out += e;  // \\ \" \' 以及别的：反斜杠脱掉，字符留着
  }
  if (i >= src.length) return { end: -1, value: out };
  return { end: i + 1, value: out };
}

/**
 * 扫一份源文件。失败时返回 null（诊断已记进 diags），成功时返回 driver.js 要的词法单元表。
 *
 * @param {any} spec readLexSpec 的输出
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {{type: string, node: any, span: any}[] | null}
 */
export function lexText(spec, file, diags) {
  const src = file.text;
  const toks = [];
  let i = 0;
  let failed = false;
  /** 上一个交出去的记号的**类型**。条件规则与自动分号都只看这一格。 */
  let prevType = null;
  /** 上一个记号的结束位置 —— 自动分号要知道"这中间有没有跨过换行" */
  let prevEnd = 0;

  for (;;) {
    // ---- 1) 跳空白、注释。跳一次可能让另一条又能跳，所以要转到不动点。
    for (;;) {
      const before = i;
      for (const terms of spec.skips) {
        const e = matchSeq(terms, 0, src, i);
        if (e > i) i = e;
      }
      for (const b of spec.blocks) {
        if (!src.startsWith(b.open, i)) continue;
        const start = i;
        let depth = 1;
        i += b.open.length;
        while (i < src.length && depth > 0) {
          if (b.nest && src.startsWith(b.open, i)) { depth++; i += b.open.length; continue; }
          if (src.startsWith(b.close, i)) { depth--; i += b.close.length; continue; }
          i++;
        }
        if (depth > 0) {
          diags.error(mkSpan(file, start, src.length), 'unterminated block comment');
          failed = true;
        }
      }
      if (i === before) break;
    }

    // ---- 1a) 自动分号（go 的 ASI）。**在跳过之后判**：跳掉的注释里那些换行也算跨过了。
    //          文件尾也补一格 —— 不然最后一条语句收不了尾。
    if (spec.autoSemi !== null && prevType !== null && spec.autoSemi.after.has(prevType)) {
      const gap = src.slice(prevEnd, i >= src.length ? src.length : i);
      if (i >= src.length || gap.includes('\n')) {
        const span = mkSpan(file, prevEnd, prevEnd);
        toks.push({ type: spec.autoSemi.type, node: { kind: 'atom', value: spec.autoSemi.text, span }, span });
        prevType = spec.autoSemi.type;
        /* prevEnd 不动：连着几个空行只补一格（上一格补完 prevType 就变成分号自己，
           而分号一般不在 after 表里，于是自然不会连着补） */
      }
    }
    if (i >= src.length) break;

    // ---- 1b) 收工标记（`#!eof` 一族）。摆在跳过之后、匹配之前：它必须落在一个
    //          **记号边界**上，不然串里的 `#!eof` 会把文件截断。
    let stopped = false;
    for (const s of spec.stops) {
      if (!src.startsWith(s.text, i)) continue;
      if (s.lineStart && i > 0 && src.charCodeAt(i - 1) !== 10) continue;
      stopped = true;
      break;
    }
    if (stopped) break;

    // ---- 2) 最长匹配。长度相同时**声明在前的赢** —— flex 的规矩，所以是严格大于才换。
    let best = -1;
    let bestEnd = i;
    let bestValue = null;
    for (let r = 0; r < spec.rules.length; r++) {
      const rule = spec.rules[r];
      /* 条件规则（`(not-after …)` / `(after …)`）：不满足就**不参赛**。
         awk 的 `/re/` 靠这一格躲开除号 —— 前面刚出现过操作数时它不参赛。 */
      if (!condOk(rule.cond === undefined ? null : rule.cond, prevType)) continue;
      let end = -1;
      let value = null;
      if (rule.kind === 'token') end = matchSeq(rule.terms, 0, src, i);
      else if (rule.kind === 'op') end = src.startsWith(rule.text, i) ? i + rule.text.length : -1;
      else if (rule.kind === 'fuse') {
        const f = matchFuse(rule, src, i);
        end = f.end;
        value = f.value;
      } else if (src.slice(i, i + 1) === rule.quote) {
        const s = scanString(src, i, rule.quote, rule.verbatim);
        end = s.end;
        value = s.value;
        if (end < 0) {
          diags.error(mkSpan(file, i, src.length), 'unterminated string');
          failed = true;
        }
      }
      if (end > bestEnd) { best = r; bestEnd = end; bestValue = value; }
    }

    if (best < 0) {
      diags.error(mkSpan(file, i, i + 1), `unexpected character ${JSON.stringify(src.slice(i, i + 1))}`);
      failed = true;
      i++;  // 往下接着扫，一趟给出尽量多的诊断
      continue;
    }

    // ---- 3) 造节点
    const rule = spec.rules[best];
    const span = mkSpan(file, i, bestEnd);
    // fuse 的文本是**规范化**的（`operator +`），不是源码里那一段
    const text = rule.kind === 'fuse' ? bestValue : src.slice(i, bestEnd);
    i = bestEnd;
    prevEnd = bestEnd;
    if (rule.kind === 'string') {
      toks.push({ type: rule.type, node: { kind: 'string', value: bestValue, raw: text.slice(1, text.length - 1), span }, span });
      prevType = rule.type;
      continue;
    }
    let type = rule.type;
    const kw = spec.keywords.get(type);
    if (kw !== undefined) {
      const re = kw.get(text);
      if (re !== undefined) type = re;
    }
    toks.push({ type, node: { kind: 'atom', value: text, span }, span });
    prevType = type;
  }

  return failed ? null : toks;
}
