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
//     (interp-string STR "'" "${" "}")        ;; 带插值的串（`'${f(a, 'x')}'`）—— 配平括号
//     (keyword ID "if" "else" "while")        ;; ID 命中这些字面量就改判成 "if" 之类
//     (keyword ID LIT "true" "false")         ;; 多写一个名字 = 改判成那个 token 类型
//     (punct SELFOP "+=" "-=")                ;; 字面量，但出指定的 token 类型
//     (fuse ID "operator" "+" "-" "init")     ;; 「一个词 + 一个算符名」粘成一个 token
//     (stop "#!eof" line-start)               ;; 扫到这儿就收工 —— 后面那些字不是源码
//     (auto-semi ";" after NAME NUM ")" "]")  ;; 跨过换行时按上一个记号补一格（go 的 ASI）
//     (auto-semi "\n" after NAME ")" (brackets "()" "[]"))  ;; …但括号里面一格都不补（R）
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
//   - **紧贴才算**（nim 的广义字符串字面量）：`re"[a-z]+"` 是一次调用，`echo "hi"` 是
//     命令式调用，两者在记号层一模一样（IDENT STRING），只差中间那个空格。
//     `(token GSTRING (tight-after IDENT ")" "]") "\"" … "\"")` —— `tight-after` 比
//     `after` 多要一句"上一个记号的末尾就是我的开头"。不分开的话同一串输入两个解，
//     GLR 会老老实实报歧义（它就该报）。
//   - **续行**（nim 的 `optInd`）：一行以二元运算符结尾时，下一行是这一行的接着写。
//     `(join-after OP8 OP9 "and" …)` —— 换行落在这些记号后面就**一个记号都不发**，
//     缩进栈也不动（等于把"括号里面是续行"那条规矩按上一个记号推广了一格）。
//     Nim 的真规矩是按列号判（`optInd` 出现 56 次），但"上一行以运算符结尾"覆盖了
//     真实代码里的绝大多数，而它只要一个记号的上下文 —— 正好是这台词法器有的那格。
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
//   (until "关")       吞到**第一个** `关` 之前（`关` 自己不吃）—— 唯一的非贪心项
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

/**
 * 读一格 `(brackets "()" "[]" ("[[" "]" 2))`。**括号这件事**有两个主顾 ——
 * `(indent …)`（括号里面的换行是续行）与 `(auto-semi … (brackets …))`（括号里面不补分号），
 * 说的是同一件事，所以读法只有这一份。
 *
 * 三种写法：
 *   `"()"`            两个字符的「开闭」
 *   `("{." ".}")`     一对字符串（nim 的 pragma：`{.` 与 `.}` 是两个多字符记号）
 *   `("[[" "]" 2)`    再多一个整数 = **这个开括号顶几层**。R 的 `[[` 就是这一格：
 *                     它是一个记号，可闭合它的 `]]` 是**两个**记号，所以 R 自己也往
 *                     contextstack 上推两格（gram.y:3990–3995）。不说这一句的话
 *                     `f(x[[1]])` 数到 `]]` 就把栈弹穿了，后面整段都以为自己在括号外。
 *
 * `suppress` 不在写法里，是**哪个子形式**说的：`(brackets …)` 里的算"里面不补"，
 * `(brackets-clear …)` 里的算"照旧补，但要盖住外面那一层"（见 readLexSpec 里那段账）。
 */
function readBrackets(node, diags, suppress) {
  const out = [];
  for (const b of node.items.slice(1)) {
    if (isStr(b) && b.value.length === 2) {
      out.push({
        open: b.value.slice(0, 1), close: b.value.slice(1, 2), weight: 1, suppress,
      });
      continue;
    }
    if (isList(b) && (b.items.length === 2 || b.items.length === 3)
        && isStr(b.items[0]) && isStr(b.items[1])) {
      const w = b.items[2];
      let weight = 1;
      if (w !== undefined) {
        /* 不是原子就给 -1（落进下面同一条报错分支）—— **不用 `Number.NaN`**：
           它不在封闭子集里（ADR-0011 决策 2），而这一份要过自举那道门
           （`tests/mir/run.js` 的 `lower/cli.js`）。解析不出数时 `parseInt` 自己
           回的就是 NaN，而 `Number.isInteger(NaN)` 是假 —— 两条路本来就同一支。 */
        const n = isAtom(w) ? Number.parseInt(w.value, 10) : -1;
        if (!Number.isInteger(n) || n < 1) {
          diags.error(w.span, 'the third item of a (brackets …) entry is how many levels this opener pushes (a positive integer)');
        } else weight = n;
      }
      out.push({
        open: b.items[0].value, close: b.items[1].value, weight, suppress,
      });
      continue;
    }
    diags.error(b === null || b === undefined ? node.span : b.span, 'each (brackets …) entry is a two-character "开闭" pair, or a ("开" "闭") / ("开" "闭" 层数) list');
  }
  return out;
}

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
  if (isStr(t)) {
    /* **单字符串用 charCodeAt 而不是 startsWith**。go 语法里 80% 的字面量是 1~2 字符的
       标点/关键字首字符。`charCodeAt` 比 `startsWith` 便宜（不查长度，不建切片）。 */
    const v = t.value;
    const vl = v.length;
    if (vl === 1) return src.charCodeAt(pos) === v.charCodeAt(0) ? pos + 1 : -1;
    if (vl === 2) return src.charCodeAt(pos) === v.charCodeAt(0)
      && src.charCodeAt(pos + 1) === v.charCodeAt(1) ? pos + 2 : -1;
    return src.startsWith(v, pos) ? pos + vl : -1;
  }
  if (isAtom(t)) {
    if (pos >= src.length) return -1;
    return inClass(t.value, src.charCodeAt(pos)) ? pos + 1 : -1;
  }
  const h = head(t);
  if (h === 'set' || h === 'not') {
    if (pos >= src.length) return -1;
    const hit = t.items[1].value.indexOf(src[pos]) >= 0;
    return hit === (h === 'set') ? pos + 1 : -1;
  }
  /* `(until "关")`：吞到**第一个** `关` 之前为止（`关` 自己不吃）。这是这套贪心不回溯的
     匹配器里唯一的非贪心项 —— 也就是正则的 `[\s\S]*?关`。块注释早就是这么扫的
     （`(block-comment 开 关)`），这一格只是把同一件事拿给 token 规则用：
     R 的原始串 `r"{…}"` 里面真会出现单个 `}`（`(?:…){0,2}` 这种正则），
     写成 `(* (not "}"))` 会停在那个 `}` 上，而"扫到第一个 `}\"`"是对的。 */
  if (h === 'until') {
    const at = src.indexOf(t.items[1].value, pos);
    return at < 0 ? -1 : at;
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
  if (h === 'until') {
    if (!isStr(t.items[1]) || t.items.length !== 2 || t.items[1].value.length === 0) {
      diags.error(t.span, '(until "关") takes exactly one non-empty string');
    }
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
 * 一条规则前面那格可选的**上下文条件**：`(after T…)`、`(not-after T…)`、`(tight-after T…)`。
 * 答 `{cond, from}` —— `from` 是"条件之后从哪一项接着读"。
 *
 * 条件里的 T 既可以是记号类型名（`NAME`），也可以是字面量（`")"`）—— 后者按 litName
 * 折成内部名，与规则那边的口径同一份代码。
 *
 * `tight-after` 比 `after` 多一格要求：**中间不许有空白**（上一个记号的末尾就是这一个
 * 记号的开头）。Nim 的广义字符串字面量要的就是这一格 —— `echo"hi"` 是一次调用，
 * `echo "hi"` 是命令式调用，两者只差一个空格；不区分的话同一串输入两个解。
 */
function readCond(items, from, diags) {
  const t = items[from];
  const h = head(t);
  if (h !== 'after' && h !== 'not-after' && h !== 'tight-after') return { cond: null, from };
  const types = new Set();
  for (const x of t.items.slice(1)) {
    if (isAtom(x)) types.add(x.value);
    else if (isStr(x)) types.add(litName(x.value));
    else diags.error(x === null || x === undefined ? t.span : x.span, `(${h} T...) takes token names or string literals`);
  }
  if (types.size === 0) diags.error(t.span, `(${h} T...) needs at least one token type`);
  return { cond: { neg: h === 'not-after', tight: h === 'tight-after', types }, from: from + 1 };
}

/**
 * 上一个交出去的记号（可能没有）满不满足这条规则的条件。
 * `tight` 那一格要看位置：`prevEnd === at` 就是"中间一个空白都没有"。
 */
function condOk(cond, prevType, prevEnd, at) {
  if (cond === null) return true;
  const hit = prevType !== null && cond.types.has(prevType);
  if (cond.neg) return !hit;
  if (!hit) return false;
  return cond.tight ? prevEnd === at : true;
}

/**
 * 读 `(lex ...)`。返回 `{skips, blocks, rules, keywords, stops, autoSemi}`：
 *   skips    : 要跳过的模式（项数组），来自 skip / comment
 *   blocks   : [{open, close, nest}] 块注释
 *   rules    : [{kind:'token'|'string'|'op'|'fuse', type, terms|quote|text, cond, span}] 按声明顺序
 *   keywords : Map<tokenType, Set<text>>
 *   keywordsFold : Set<tokenType> —— 这几格记号类型的关键字不分大小写（basic 那一族）
 *   stops    : 扫到就收工的那几段文本（`#!eof` 一族）
 *   autoSemi : `{type, text, after:Set, unlessBefore:[string], brackets}` 或 null —— 跨过换行时补的那一格
 *              （go 的 ASI）。`unlessBefore` 里那几段文本挡住它：下一格文本以它们起头就不补。
 *   indent   : `{nl, indent, dedent, brackets}` 或 null —— 缩进即块结构那一族（python / nim）
 *   joinAfter: Set<tokenType> 或 null —— 落在这些记号后面的换行是**续行**（nim 的 optInd）
 */
export function readLexSpec(node, diags) {
  const skips = [];
  const blocks = [];
  const rules = [];
  const keywords = new Map();
  const keywordsFold = new Set();
  const stops = [];
  let autoSemi = null;
  let indent = null;
  let joinAfter = null;
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
      const flags = it.items.slice(3).filter((f) => isAtom(f)).map((f) => f.value);
      const nest = flags.includes('nest');
      /**
       * `eof-ok`：**到文件尾还没关也算关了**（不报 unterminated）。
       *
       * 为什么要这一格而不是一律宽容：C 那一族里"没关的块注释"是真错（它会把后面整份文件
       * 吃掉）。可有的语言的正本压根不检查 —— EVAL（`.pss`/`.kc`）那台剥注释的机器就是
       * 一遍扫描加一格 `got` 旗子（`polydraw_src/eval.c:6893`），扫到头就结束，
       * 于是作者在文件末尾用 `/*` 压一段笔记是**合法的写法**（`games/snood.kc:295`）。
       * 这一格由语法自己声明，别的语言一个字都不受影响。
       */
      const eofOk = flags.includes('eof-ok');
      if (flags.some((f) => f !== 'nest' && f !== 'eof-ok')) {
        diags.error(it.span, "the only flags after (block-comment OPEN CLOSE) are 'nest' and 'eof-ok'");
      }
      blocks.push({
        open: open.value, close: close.value, nest, eofOk, openC0: open.value.charCodeAt(0),
      });
      continue;
    }
    if (h === 'indent') {
      /* `(indent NEWLINE INDENT DEDENT (brackets "()" "[]" "{}"))`
       *
       * python / nim / mojo 那一族：**行的缩进就是块结构**。词法器为此要一格栈（缩进列宽）
       * 与一格计数（括号深度）—— 括号里面的换行是续行，不出记号（隐式行连接）。
       * 这是这套词法器里唯一有"栈"的一格，所以它是显式声明的，不许悄悄开着。
       *
       * `brackets` 每一项要么是**两个字符**的 `"开闭"`（`"()"`），要么是一对字符串
       * `("{." ".}")` —— 后者给 nim 的 pragma 用：`{.` 与 `.}` 是两个多字符记号，
       * 而 pragma 里换行也是续行（`{.magic: "X", deprecated:\n  "…".}` 是一份真代码）。
       * 深度是按记号文本数的，所以串里的括号不算（那时已经被 `(string …)` 收成一个记号了）。 */
      const nm = [];
      let brackets = [];
      for (const x of it.items.slice(1)) {
        if (isAtom(x)) { nm.push(x.value); continue; }
        if (head(x) === 'brackets') {
          brackets = readBrackets(x, diags, true);
          continue;
        }
        diags.error(x === null || x === undefined ? it.span : x.span, 'unknown item in (indent …)');
      }
      if (nm.length !== 3) { diags.error(it.span, '(indent NEWLINE INDENT DEDENT [(brackets …)]) needs exactly three token names'); continue; }
      if (indent !== null) diags.error(it.span, 'a lexer spec may have at most one (indent …) form');
      indent = { nl: nm[0], indent: nm[1], dedent: nm[2], brackets };
      continue;
    }
    if (h === 'join-after') {
      /* `(join-after OP8 OP9 "," "and")`：换行落在这些记号后面就是**续行** ——
       * 一个记号都不发，缩进栈也不动。nim 的 `optInd` 那一族靠这一格。
       * 只在 `(indent …)` 那一族里有意义（没有缩进栈的语言换行本来就不出记号）。 */
      const set = new Set();
      for (const x of it.items.slice(1)) {
        if (isAtom(x)) set.add(x.value);
        else if (isStr(x)) set.add(litName(x.value));
        else diags.error(x === null || x === undefined ? it.span : x.span, '(join-after T...) takes token names or string literals');
      }
      if (set.size === 0) diags.error(it.span, '(join-after T...) needs at least one token type');
      if (joinAfter !== null) diags.error(it.span, 'a lexer spec may have at most one (join-after …) form');
      joinAfter = set;
      continue;
    }
    if (h === 'auto-semi') {
      /* `(auto-semi ";" after NAME NUMBER ")" "}")`：跨过换行时，若上一个记号在 after
       * 那张表里，就补一格。Go 的规范把它写成词法规则（"分号自动插入"），V 照抄。
       * 文件末尾也补一格 —— 不然最后一条语句收不了尾。
       *
       * 尾巴上还能跟一句 `unless-before "&&" "||"`：**下一格文本以这几段起头就不补**。
       * 为什么要有它：Go 要求续行的算符写在行尾，所以"看上一个记号"够了；V 不要求，
       * 语料里到处是
       *     if a != 'HEAD'
       *         && os.execute(…).exit_code == 0 {
       * 这时上一个记号（STRING）在 after 表里，可下一行是那个表达式的下半截。
       * 判据只能是"往前看一眼"，而这一眼词法器出得起 —— 补分号这件事发生在跳过空白
       * **之后**、读下一格记号**之前**，光标正停在那儿。
       *
       * 只收字面文本、不收记号类型：这一格要在"还没切出记号"的时候判，手上只有字符。
       *
       * 再跟一句 `(brackets "()" "[]")`：**括号里面一格都不补**。R 要这一格 ——
       * 它的词法器为此专门有一个 `contextstack`（`gram.y:3828`：
       * `if (EatLines || *contextp == '[' || *contextp == '(') goto again;`），
       * 而"往前看一眼"顶不掉它：`structure(list` 换行再接 `(height = …)` 这种写法里，
       * 下一格文本是 `(` —— 它**真能**起一个表达式，所以不敢放进 unless-before。
       *
       * 注意 R 那句判的是**栈顶**，不是"栈里有没有" —— 所以还要一句
       * `(brackets-clear "{}")`：花括号照旧入栈（它得盖住外面那层 `(`），但它**里面**
       * 换行仍然是分隔符。`f(function(x) {` 换行 `…` 换行 `})` 这种写法（R 的标准库里
       * 到处是）就靠这一格：少了它，`{…}` 里的语句会全挤成一条。
       * 深度按**记号文本**数（串里的括号早就收成一个记号了，不会算进来）。 */
      const s = it.items[1];
      if (!isStr(s) || s.value.length === 0) { diags.error(it.span, '(auto-semi ";" after T...) needs the text to insert'); continue; }
      const kw = it.items[2];
      if (!isAtom(kw) || kw.value !== 'after') { diags.error(it.span, "(auto-semi \";\" after T...) needs the word 'after'"); continue; }
      const after = new Set();
      const unlessBefore = [];
      let asBrackets = [];
      let mode = 'after';
      for (const x of it.items.slice(3)) {
        if (isList(x) && head(x) === 'brackets') { asBrackets = asBrackets.concat(readBrackets(x, diags, true)); continue; }
        if (isList(x) && head(x) === 'brackets-clear') { asBrackets = asBrackets.concat(readBrackets(x, diags, false)); continue; }
        if (isAtom(x) && x.value === 'unless-before') { mode = 'unless'; continue; }
        if (mode === 'unless') {
          if (isStr(x) && x.value.length > 0) unlessBefore.push(x.value);
          else diags.error(x === null || x === undefined ? it.span : x.span, 'an unless-before entry must be a non-empty string literal');
          continue;
        }
        if (isAtom(x)) after.add(x.value);
        else if (isStr(x)) after.add(litName(x.value));
        else diags.error(x === null || x === undefined ? it.span : x.span, 'an auto-semi trigger must be a token name or a string literal');
      }
      if (after.size === 0) diags.error(it.span, '(auto-semi ...) needs at least one trigger token');
      if (mode === 'unless' && unlessBefore.length === 0) diags.error(it.span, '(auto-semi ... unless-before "…") needs at least one string');
      if (autoSemi !== null) diags.error(it.span, 'a lexer spec may have at most one (auto-semi ...) form');
      autoSemi = {
        type: litName(s.value), text: s.value, after, unlessBefore, brackets: asBrackets,
      };
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
      const flags = it.items.slice(c.from + 1).filter((f) => isAtom(f)).map((f) => f.value);
      const verbatim = flags.includes('verbatim');
      /**
       * `join`：**挨着的两个串字面量拼成一个**（C 的翻译阶段 6：`"a" "b"` == `"ab"`）。
       *
       * 这一格在词法层做，不在语法层：语法层要么加一条 `串 -> 串 串` 的产生式（GLR 表上
       * 平白多一处歧义），要么让 `str` 节点变成可变长（读它的地方全得改）。词法层就是
       * "上一个记号也是同一种串就接上去"，一句话的事。
       * 语料里 `games/traffic.kc:810` 那段多行帮助文本用的就是这个写法。
       */
      const join = flags.includes('join');
      /**
       * `char3`：**引号 + 一个字符 + 引号**这一档优先（那个字符**可以是引号自己**）。
       *
       * 正本的字符字面量就是这条规则（`polydraw_src/eval.c:6909`）：
       * `if ((st[i]=='\'') && (st[i+1]>=32) && (st[i+2]=='\'')) i += 2;` —— 三个字符，
       * 中间那个只要 >= 32，**没有转义这回事**。所以 `'''` 是撇号本身
       * （`geeky/morse.kc:68` 的莫尔斯码表里就有这一行），而按"带转义的串"去扫会把
       * 第二个引号当成收尾、第三个引号又开一个新串，整份文件从那儿起全错位。
       * 三字符这一档不成立时（`'\n'` 那种）照旧走带转义的扫法。
       */
      const char3 = flags.includes('char3');
      if (flags.some((f) => f !== 'verbatim' && f !== 'join' && f !== 'char3')) {
        diags.error(it.span, "the only flags after (string NAME \"Q\") are 'verbatim', 'join' and 'char3'");
      }
      rules.push({
        kind: 'string', type: nm, quote: q.value, verbatim, join, char3, cond: c.cond, span: it.span,
      });
      continue;
    }
    if (h === 'interp-string') {
      /* `(interp-string STRING "'" "${" "}")` —— **带插值的串**（V、Kotlin、Swift、
       * JS 的模板串都是这一族）。为什么它不能靠 `(string …)` 或 `(token …)` 写出来：
       *
       *   `'${os.join_path(out, 'index.html')}'`
       *
       * 插值里**又有引号**。一个不回溯、按最长匹配挑规则的词法器写不出"扫到第一个未被
       * 插值括起来的引号为止" —— 那要**配平括号**，而配平是记数，不是模式。所以这一格
       * 只能是词法器里的一段代码。量过：V 的语料里 290 份文件卡在这一条。
       *
       * 整个串（连插值）收成**一格记号**。切开插值是另一件事（要能递归回表达式），
       * 这一格不做，也不假装做。
       *
       * `OPEN` 的末字符必须是 `{`、`CLOSE` 必须是 `}` —— 配平数的就是这一对。 */
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      const c = readCond(it.items, 2, diags);
      const q = it.items[c.from];
      const op = it.items[c.from + 1];
      const cl = it.items[c.from + 2];
      if (nm === null || !isStr(q) || q.value.length !== 1 || !isStr(op) || !isStr(cl)) {
        diags.error(it.span, '(interp-string NAME "Q" "${" "}") needs a name, a one-character quote, and the two brace strings');
        continue;
      }
      if (!op.value.endsWith('{') || cl.value !== '}') {
        diags.error(it.span, '(interp-string …) needs OPEN to end with "{" and CLOSE to be "}" — 配平数的就是这一对');
        continue;
      }
      rules.push({ kind: 'interp', type: nm, quote: q.value, open: op.value, cond: c.cond, span: it.span });
      continue;
    }
    if (h === 'keyword') {
      const nm = isAtom(it.items[1]) ? it.items[1].value : null;
      if (nm === null) { diags.error(it.span, '(keyword TYPE w...) needs a token type'); continue; }
      /* `fold-case`：这一格记号类型的关键字**不分大小写**（basic / fortran / sql 那一族）。
         写在类型名后面：`(keyword NAME fold-case "type" "end" …)`。表里存小写，查表前
         把记号文本折成小写 —— 一门语言里要么全折要么全不折，所以按**记号类型**记这一格，
         不按单个词记。 */
      let from = 2;
      let fold = false;
      if (isAtom(it.items[from]) && it.items[from].value === 'fold-case') { fold = true; from++; }
      // 接下来那一项如果又是个名字，它就是**改判成什么**：camp.l 里 `true` 是 LIT 而不是
      // 关键字，于是写 `(keyword ID LIT "true" ...)`。省掉它就改判成字面量终结符（`"if"` 那种）。
      let to = null;
      if (isAtom(it.items[from])) { to = it.items[from].value; from++; }
      if (!keywords.has(nm)) keywords.set(nm, new Map());
      if (fold) keywordsFold.add(nm);
      for (const w of it.items.slice(from)) {
        if (isStr(w)) keywords.get(nm).set(fold ? w.value.toLowerCase() : w.value, to === null ? litName(w.value) : to);
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
  return { skips, blocks, rules, keywords, keywordsFold, stops, autoSemi, indent, joinAfter };
}

// ---- 扫描 ------------------------------------------------------------------

/**
 * 带插值的串（`(interp-string …)`）。从开引号扫到**配平之后**那个闭引号。
 *
 * 与 scanString 的唯一区别是那一段 `${ … }`：进去之后按 `{` / `}` 记数，
 * 里头遇到引号就成对跳过（那是插值里的串，不是这一层的收尾）。这也是为什么它写不成
 * 一条模式 —— 记数不是模式。
 *
 * 答 `{end, value}`；`value` 是**原样的内文**（连插值），不做转义解释：这一格的
 * 记号是给语法层看形状的，串的值要等切开插值那一步才有意义。`end < 0` 表示没闭合。
 */
function scanInterp(src, pos, quote, open) {
  let j = pos + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return { end: j + 1, value: src.slice(pos + 1, j) };
    if (src.startsWith(open, j)) {
      j += open.length;
      let depth = 1;
      while (j < src.length && depth > 0) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '{') { depth++; j++; continue; }
        if (d === '}') { depth--; j++; continue; }
        if (d === "'" || d === '"' || d === '`') {
          const q2 = d;
          j++;
          while (j < src.length && src[j] !== q2) { j += src[j] === '\\' ? 2 : 1; }
          j++;
          continue;
        }
        j++;
      }
      continue;
    }
    j++;
  }
  return { end: -1, value: null };
}

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
  /** 缩进栈与**括号栈**：`(indent …)` 与 `(auto-semi … (brackets …))` 两族用得到 */
  const cols = [0];
  /* 一层一格布尔（这一层要不要压住"补分号"）。**是栈不是计数** —— R 判的是
     `*contextp == '['` 与 `== '('`，也就是**栈顶**：`f(function(x) { … })` 里面那几个换行
     照旧是分隔符，因为栈顶是 `{`。计数版在这批语料上量过，962 份从 940 掉到 728。 */
  const nest = [];
  /* 括号表只有一份来源：谁声明了 `(brackets …)` 就用谁的（两族不会同时声明 —— 有缩进栈的
     语言括号里本来就不出换行记号，不必再补分号）。 */
  const depthBrackets = spec.indent !== null ? spec.indent.brackets
    : (spec.autoSemi !== null ? spec.autoSemi.brackets : []);

  const push = (type, text, at, end) => {
    const span = mkSpan(file, at, end);
    toks.push({ type, node: { kind: 'atom', value: text, span }, span });
    prevType = type;
  };

  /** 跳空白、注释。跳一次可能让另一条又能跳，所以要转到不动点。 */
  const skipTrivia = () => {
    for (;;) {
      const before = i;
      /* **块注释先试**：`#[ … ]#` 与 `#` 到行尾这一对（Nim）里，行注释的开头是块注释
         开头的前缀。先试 skips 的话 `#` 永远赢，`#[` 那一段的后几行就会当代码读
         （Nim 的 locks.nim 就死在 `noop's` 那个撇号上）。块注释的开头更长更具体，
         所以它先。空白与块注释的开头不重叠，这么排不影响别的语言。 */
      for (const b of spec.blocks) {
        /* 短路：块注释开头的第一个字符不匹配就跳——比 startsWith 快一个量级。 */
        if (src.charCodeAt(i) !== b.openC0) continue;
        if (!src.startsWith(b.open, i)) continue;
        const start = i;
        let d = 1;
        i += b.open.length;
        while (i < src.length && d > 0) {
          if (b.nest && src.startsWith(b.open, i)) { d++; i += b.open.length; continue; }
          if (src.startsWith(b.close, i)) { d--; i += b.close.length; continue; }
          i++;
        }
        if (d > 0 && !b.eofOk) {
          diags.error(mkSpan(file, start, src.length), 'unterminated block comment');
          failed = true;
        }
      }
      for (const terms of spec.skips) {
        const e = matchSeq(terms, 0, src, i);
        if (e > i) i = e;
      }
      if (i === before) return;
    }
  };

  for (;;) {
    // ---- 1) 空白与注释
    skipTrivia();

    // ---- 1a') 缩进（python / nim / mojo 那一族）。**只在括号外面算** ——
    //          括号里面换行是"续行"，那是这几门语言共同的规矩（隐式行连接）。
    //          空行与纯注释行不出记号：量完缩进再跳一遍 trivia，又停在换行上就说明这一行是空的。
    if (spec.indent !== null && nest.length > 0) {
      /* 括号里面：换行是**续行**，一个记号都不发 —— 吃掉它与后面那截缩进就行。
         这一格与"栈空"那一格是同一件事的两面，所以摆在一起。 */
      for (;;) {
        const before = i;
        while (i < src.length) {
          const c = src.charCodeAt(i);
          if (c !== 10 && c !== 13 && c !== 32 && c !== 9) break;
          i++;
        }
        skipTrivia();
        if (i === before) break;
      }
    }
    if (spec.indent !== null && nest.length === 0) {
      let sawNL = false;
      let col = 0;
      for (;;) {
        if (i >= src.length) break;
        const c = src.charCodeAt(i);
        if (c !== 10 && c !== 13) break;
        if (c === 13) i++;
        if (i < src.length && src.charCodeAt(i) === 10) i++;
        sawNL = true;
        col = 0;
        while (i < src.length) {
          const d = src.charCodeAt(i);
          if (d === 32) { col++; i++; continue; }
          if (d === 9) { col += 8 - (col % 8); i++; continue; }
          break;
        }
        skipTrivia();
      }
      /* `toks.length > 0`：NEWLINE 是**上一条逻辑行的句号**，前面没有记号就没有行要收。
         文件开头那几行注释（Nim 的 `##` 文件头、python 的 shebang 之后）会走到这儿，
         少了这一格判断就会在记号流最前面多出一个 NEWLINE —— Nim 标准库 316 份因此
         一份不过。与文件尾那格 `toks.length > 0` 是同一条道理。

         `joined`：上一个记号在 `(join-after …)` 表里，这个换行就是**续行** —— 什么都不发，
         缩进栈也不动。等于把"括号里面的换行是续行"那条规矩按上一个记号推广了一格。 */
      const joined = spec.joinAfter !== null && prevType !== null && spec.joinAfter.has(prevType);
      if (sawNL && i < src.length && toks.length > 0 && !joined) {
        push(spec.indent.nl, '\n', i, i);
        if (col > cols[cols.length - 1]) {
          cols.push(col);
          push(spec.indent.indent, '', i, i);
        } else {
          /* 不要求精确对上某一层：一路弹到 <= col 为止。对不上的那种缩进
             （`a` 4 格、`b` 2 格）在这儿只是少发一格 DEDENT，语法那边会报 —— 那句话
             比"缩进对不上"具体（它会说这儿缺什么）。 */
          while (cols.length > 1 && col < cols[cols.length - 1]) {
            cols.pop();
            push(spec.indent.dedent, '', i, i);
          }
        }
      }
    }

    // ---- 1a) 自动分号（go 的 ASI）。**在跳过之后判**：跳掉的注释里那些换行也算跨过了。
    //          文件尾也补一格 —— 不然最后一条语句收不了尾。
    //          声明了 `(brackets …)` 的话，**括号里面一格都不补**（R 的 contextstack）。
    if (spec.autoSemi !== null && prevType !== null && spec.autoSemi.after.has(prevType)
        && !(nest.length > 0 && nest[nest.length - 1])) {
      const gap = src.slice(prevEnd, i >= src.length ? src.length : i);
      let blocked = false;
      if (i < src.length) {
        for (const t of spec.autoSemi.unlessBefore) {
          if (src.startsWith(t, i)) { blocked = true; break; }
        }
      }
      if (!blocked && (i >= src.length || gap.includes('\n'))) {
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
      /* 条件规则（`(not-after …)` / `(after …)` / `(tight-after …)`）：不满足就**不参赛**。
         awk 的 `/re/` 靠这一格躲开除号 —— 前面刚出现过操作数时它不参赛。
         Nim 的 `re"…"` 靠 tight 那一格与命令式调用分开。 */
      if (!condOk(rule.cond === undefined ? null : rule.cond, prevType, prevEnd, i)) continue;
      let end = -1;
      let value = null;
      if (rule.kind === 'token') end = matchSeq(rule.terms, 0, src, i);
      else if (rule.kind === 'op') end = src.startsWith(rule.text, i) ? i + rule.text.length : -1;
      else if (rule.kind === 'fuse') {
        const f = matchFuse(rule, src, i);
        end = f.end;
        value = f.value;
      } else if (rule.kind === 'interp') {
        if (src.slice(i, i + 1) === rule.quote) {
          const s = scanInterp(src, i, rule.quote, rule.open);
          end = s.end;
          value = s.value;
          if (end < 0) {
            diags.error(mkSpan(file, i, src.length), 'unterminated interpolated string');
            failed = true;
          }
        }
      } else if (src.slice(i, i + 1) === rule.quote) {
        /* `char3`：引号 + 一个字符（可以是引号自己）+ 引号，优先于带转义那条扫法。 */
        if (rule.char3 === true && i + 2 < src.length
            && src.slice(i + 2, i + 3) === rule.quote && src.slice(i + 1, i + 2) !== '\n') {
          end = i + 3;
          value = src.slice(i + 1, i + 2);
        } else {
          const s = scanString(src, i, rule.quote, rule.verbatim);
          end = s.end;
          value = s.value;
          if (end < 0) {
            diags.error(mkSpan(file, i, src.length), 'unterminated string');
            failed = true;
          }
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
    if (rule.kind === 'string' || rule.kind === 'interp') {
      /* `join`（C 的翻译阶段 6）：**挨着的同一种串接上去**，不另发一个记号。
         中间只允许空白与注释 —— 它们在上头那一趟 trivia 里已经吃掉了，所以这儿
         只要看"上一个记号是不是同一种串"。 */
      const last = toks.length > 0 ? toks[toks.length - 1] : null;
      if (rule.join === true && last !== null && last.type === rule.type
          && last.node.kind === 'string') {
        last.node.value += bestValue;
        last.node.raw += text.slice(1, text.length - 1);
        last.node.span = mkSpan(file, last.span.start, bestEnd);
        last.span = last.node.span;
        prevType = rule.type;
        continue;
      }
      toks.push({ type: rule.type, node: { kind: 'string', value: bestValue, raw: text.slice(1, text.length - 1), span }, span });
      prevType = rule.type;
      continue;
    }
    let type = rule.type;
    const kw = spec.keywords.get(type);
    if (kw !== undefined) {
      const re = kw.get(spec.keywordsFold.has(type) ? text.toLowerCase() : text);
      if (re !== undefined) type = re;
    }
    toks.push({ type, node: { kind: 'atom', value: text, span }, span });
    prevType = type;
    /* 括号栈按**记号文本**推：串里的括号早就被收成一个记号了，不会算进来。 */
    for (const b of depthBrackets) {
      if (text === b.open) { for (let k = 0; k < b.weight; k++) nest.push(b.suppress); break; }
      if (text === b.close) { if (nest.length > 0) nest.pop(); break; }
    }
  }

  /* 文件尾：补一格 NEWLINE（如果最后一条语句还没收尾）再把缩进栈弹空。
     不补的话最后一个块收不了尾 —— 与 go 的 ASI 在文件尾补一格是同一件事。 */
  if (spec.indent !== null && toks.length > 0) {
    const end = src.length;
    if (prevType !== spec.indent.nl && prevType !== spec.indent.dedent) push(spec.indent.nl, '\n', end, end);
    while (cols.length > 1) {
      cols.pop();
      push(spec.indent.dedent, '', end, end);
    }
  }

  return failed ? null : toks;
}
