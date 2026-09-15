// src/core/glr/yacc.js —— bison/yacc 的 `.y` 直接读进来（ADR-0014 决策 2 的第二个入口）
//
// 为什么要有这一格：语法这件事外面已经写了几十年，参考树里躺着的是**别人写好的** .y ——
// asymptote 的 parser.y（1900 行）、bison 自己 examples 下那一批、还有我们早期半成品定下的
// 那份混合 .y（omni.y / mini.y：词法也写在同一个文件里）。要「加一门语言 = 一份语法 + 一份
// 映射标注」，那就不该要求每一门先手抄一遍语法 —— 手抄一遍就是手抄一遍的错。
//
// 做法只有一句：**`.y` 转成我们那份 `(grammar ...)` 文本，再走同一条路**
// （readSexpr -> readGrammar -> buildTable）。不新开一条解析器，于是：
//   - 语法的语义（终结符/优先级/`%prec`/空产生式/起始符号）只有 grammar.js 那一份说法；
//   - 构表的内容寻址缓存照旧生效 —— 键是**转出来的**那段文本，`.y` 改一个字符键就变；
//   - 转出来的东西人能读、能 diff、能进快照 —— 这是这一格唯一诚实的判据。
//
// 收两种方言，同一个读入器（差别只在词法那一段在不在文件里）：
//
//   1. **真 bison**：`%{ … %}`、`%union {…}`、`%token <tag> A B 'c'`、`%left '+' '-'`、
//      `%type`、`%nterm`、`%expect`、`%glr-parser`、`%dprec`、`%merge`、`%prec`、
//      `%%` 前后两段、动作是 C 代码。词法在 `.l` 里，所以转出来的语法**没有** `(lex …)`：
//      能建表、能拿现成的 token 表分析，不能直接吃源文本（`omni glr parse` 会照实说）。
//   2. **混合 .y**（早期 omni 定下的那份）：多两条声明把词法也写在同一处 ——
//      `%skip NAME 正则` 与 `%lex NAME 正则`，动作写成 `{ 标签 }` 而不是 C 代码。
//      这一支转出来的语法带 `(lex …)`，`omni glr parse x.y prog.txt` 当场能跑。
//
// 三处**定义**（不是猜，写在这儿是为了别人翻到这儿就知道口径）：
//
//   - **动作只留名字，不解释语义**。`{ append }` 出 `(append $1 $2 …)`；C 代码那种整段丢掉，
//     标签取产生式左部的名字。于是转出来的树是一棵具体语法树（CST）—— 每条产生式一个节点、
//     子节点按 RHS 位置排。把 CST 变成某门语言的 AST 是「映射标注」那一层的事，`.y` 里
//     那段 C 代码说的是**别人的** AST，照搬过来只会搬进别人的数据结构。
//   - **正则里的 `^` 和 `$` 是普通字符**。词法器永远从一个记号边界起扫，行首/行尾锚点在这里
//     没有意义（`%lex XOR_ASSIGN ^=` 要的就是那个尖角）。
//   - **`word\b` 转成一条 punct**，`\b` 不另外落实：我们的词法器是「最长匹配优先、同长
//     声明在前的赢」（lex.js），于是 `in` 与 `index` 之争由长度定胜负 —— 与 `\b` 同解。
//     前提是这门语言有一条能吃下整个标识符的规则；没有那条规则的话 `index` 本来也扫不出来。
//
// 正则的子集是刻意小的：看不懂就报错，不猜（`{n,m}`、`(?=…)`、反向引用、`\B`、非贪心那几种
// 除块注释以外的形状，一律当场说"不支持"）。理由与 lex.js 同一条：封闭 ABI 里没有
// `new RegExp(str)`，模式必须在**转换期**折成词法项，折不动就得让写的人知道。

import { span as mkSpan } from '../source/diag.js';

/** `.y` 走这条路。`.yy`/`.ypp` 是 C++ 的习惯写法，同一个格式。 */
export const isYaccPath = (p) => p.endsWith('.y') || p.endsWith('.yy') || p.endsWith('.ypp');

const isSpaceCC = (cc) => cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12 || cc === 11;
const isDigitCC = (cc) => cc >= 48 && cc <= 57;
const isAlphaCC = (cc) => (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
/** 符号名的首字符。bison 还认 `.`，但首位是 `.` 的名字没人写。 */
const isNameHeadCC = (cc) => isAlphaCC(cc) || cc === 95;
/** 符号名的后续字符：bison 的符号名认 `-` 与 `.`（`%define` 的键名全靠 `-`）。 */
const isNameCC = (cc) => isNameHeadCC(cc) || isDigitCC(cc) || cc === 45 || cc === 46;

/** 字面量终结符的内部名 —— 与 lex.js 的 litName 同一个口径，也正好是转出来的文本 */
const q = (s) => JSON.stringify(s);

// ---- 1) `.y` 自己的记号 ------------------------------------------------------
//
// 记号种类：`%%`（分段）、`prologue`（`%{ … %}`，整段丢）、`%`（指令名）、`id`、
// `lit`（`'c'`，解转义后的文本）、`str`（`"…"`）、`num`、`:` `|` `;`、
// `<`（`<类型标签>`，丢）、`[`（bison 的命名引用 `expr[lhs]`，丢）、`{`（动作体原文）、`eof`。
//
// 刻意是**惰性**扫描（一个游标 + 一小格缓冲）：混合方言的 `%lex NAME 正则` 要的是
// 「这一行剩下的原文」，而正则里什么字符都可能有（`//[^\n]*` 自己就长得像注释）——
// 那一格只能绕过记号层直接看源文本。

class YScan {
  constructor(file, diags) {
    this.file = file;
    this.src = file.text;
    this.diags = diags;
    this.i = 0;
    /** 已经扫出来还没交出去的记号，[0] 是下一个 */
    this.buf = [];
  }

  err(at, msg) {
    this.diags.error(mkSpan(this.file, at, at < this.src.length ? at + 1 : this.src.length), msg);
  }

  fill(n) {
    while (this.buf.length < n) this.buf.push(this.scan());
  }

  peek(k) {
    this.fill((k === undefined ? 0 : k) + 1);
    return this.buf[k === undefined ? 0 : k];
  }

  next() {
    this.fill(1);
    return this.buf.shift();
  }

  /**
   * 这一行剩下的原文（去掉两头空白）与它的起始 offset。混合方言的 `%skip` / `%lex` 用它。
   * 缓冲里要是已经有先扫出来的记号，把游标退回那一格再读 —— 不然会少掉一截。
   */
  restOfLine() {
    if (this.buf.length > 0) {
      this.i = this.buf[0].at;
      this.buf = [];
    }
    while (this.i < this.src.length && (this.src.charCodeAt(this.i) === 32 || this.src.charCodeAt(this.i) === 9)) this.i++;
    const at = this.i;
    const e = this.src.indexOf('\n', this.i);
    const end = e < 0 ? this.src.length : e;
    this.i = end;
    return { text: this.src.slice(at, end).trim(), at };
  }


  /** 空白与两种注释（bison 认 `/* *\/` 也认 `//`）。跳到不动点。 */
  ws() {
    for (;;) {
      const before = this.i;
      while (this.i < this.src.length && isSpaceCC(this.src.charCodeAt(this.i))) this.i++;
      if (this.src.startsWith('/*', this.i)) {
        const e = this.src.indexOf('*/', this.i + 2);
        this.i = e < 0 ? this.src.length : e + 2;
      } else if (this.src.startsWith('//', this.i)) {
        const e = this.src.indexOf('\n', this.i);
        this.i = e < 0 ? this.src.length : e;
      }
      if (this.i === before) return;
    }
  }

  scan() {
    this.ws();
    const at = this.i;
    const src = this.src;
    if (at >= src.length) return { k: 'eof', v: '', at };
    if (src.startsWith('%%', at)) { this.i = at + 2; return { k: '%%', v: '', at }; }
    if (src.startsWith('%{', at)) {
      const e = src.indexOf('%}', at + 2);
      this.i = e < 0 ? src.length : e + 2;
      if (e < 0) this.err(at, 'unterminated %{ … %} prologue');
      return { k: 'prologue', v: '', at };
    }
    const c = src.slice(at, at + 1);
    if (c === '%') {
      this.i = at + 1;
      while (this.i < src.length && isNameCC(src.charCodeAt(this.i))) this.i++;
      return { k: '%', v: src.slice(at + 1, this.i), at };
    }
    if (c === '{') return this.brace(at);
    if (c === '<') {
      // `%type <::std::vector<std::string>>` —— C++ 的类型标签自己带 `<>`，要数层数
      let j = at + 1;
      let depth = 1;
      while (j < src.length && depth > 0) {
        const ch = src.slice(j, j + 1);
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
        else if (ch === '\n') break;
        j++;
      }
      if (depth > 0) this.err(at, 'unterminated <type> tag');
      this.i = j;
      return { k: '<', v: src.slice(at + 1, j > at + 1 ? j - 1 : at + 1), at };
    }
    if (c === '[') {
      const e = src.indexOf(']', at + 1);
      this.i = e < 0 ? src.length : e + 1;
      if (e < 0) this.err(at, 'unterminated [named-reference]');
      return { k: '[', v: src.slice(at + 1, e < 0 ? src.length : e), at };
    }
    if (c === "'") return this.quoted(at, "'", 'lit');
    if (c === '"') return this.quoted(at, '"', 'str');
    if (c === ':' || c === '|' || c === ';' || c === '(' || c === ')') { this.i = at + 1; return { k: c, v: c, at }; }
    if (isDigitCC(src.charCodeAt(at))) {
      this.i = at;
      while (this.i < src.length && isNameCC(src.charCodeAt(this.i))) this.i++;
      return { k: 'num', v: src.slice(at, this.i), at };
    }
    if (isNameHeadCC(src.charCodeAt(at))) {
      this.i = at;
      while (this.i < src.length && isNameCC(src.charCodeAt(this.i))) this.i++;
      return { k: 'id', v: src.slice(at, this.i), at };
    }
    this.i = at + 1;
    this.err(at, `unexpected character ${q(c)} in a .y file`);
    return { k: 'bad', v: c, at };
  }

  /** 平衡的 `{ … }`。里面是 C 代码，所以串、字符、两种注释都要认（`'}'` 不算收尾）。 */
  brace(at) {
    const src = this.src;
    let i = at + 1;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      const ch = src.slice(i, i + 1);
      if (ch === '"' || ch === "'") { i = this.skipQuoted(i, ch); continue; }
      if (ch === '{') { depth++; i++; continue; }
      if (ch === '}') { depth--; i++; continue; }
      i++;
    }
    if (depth > 0) this.err(at, 'unterminated { … } action block');
    const body = src.slice(at + 1, i > at + 1 ? i - 1 : at + 1);
    this.i = i;
    return { k: '{', v: body, at };
  }

  /** C 代码里的一段引号串：只用来**跨过去**，不解转义。不闭合就当它到行尾为止。 */
  skipQuoted(i, quote) {
    const src = this.src;
    let j = i + 1;
    while (j < src.length) {
      const ch = src.slice(j, j + 1);
      if (ch === '\\') { j += 2; continue; }
      if (ch === quote) return j + 1;
      if (ch === '\n') return j;
      j++;
    }
    return j;
  }

  /** `'c'` 与 `"…"`：解转义，出文本。 */
  quoted(at, quote, kind) {
    const src = this.src;
    let i = at + 1;
    let out = '';
    while (i < src.length && src.slice(i, i + 1) !== quote) {
      if (src.slice(i, i + 1) !== '\\') { out += src.slice(i, i + 1); i++; continue; }
      const d = unescapeAt(src, i);
      out += d.text;
      i = d.end;
    }
    if (i >= src.length) this.err(at, 'unterminated literal');
    this.i = i + 1;
    return { k: kind, v: out, at };
  }
}

/** C/bison 的转义表。`src[i]` 是那个反斜杠。返回 `{text, end}`。 */
function unescapeAt(src, i) {
  const e = src.slice(i + 1, i + 2);
  if (e === 'n') return { text: '\n', end: i + 2 };
  if (e === 't') return { text: '\t', end: i + 2 };
  if (e === 'r') return { text: '\r', end: i + 2 };
  if (e === 'a') return { text: '\u0007', end: i + 2 };
  if (e === 'b') return { text: '\b', end: i + 2 };
  if (e === 'f') return { text: '\f', end: i + 2 };
  if (e === 'v') return { text: '\v', end: i + 2 };
  if (e === 'x') {
    let j = i + 2;
    while (j < src.length && /^[0-9a-fA-F]$/.test(src.slice(j, j + 1))) j++;
    if (j === i + 2) return { text: 'x', end: i + 2 };
    return { text: String.fromCharCode(Number.parseInt(src.slice(i + 2, j), 16)), end: j };
  }
  if (e >= '0' && e <= '7') {
    let j = i + 1;
    while (j < src.length && j < i + 4 && src.slice(j, j + 1) >= '0' && src.slice(j, j + 1) <= '7') j++;
    return { text: String.fromCharCode(Number.parseInt(src.slice(i + 1, j), 8)), end: j };
  }
  return { text: e, end: i + 2 };
}

// ---- 2) 正则 -> 词法项 -------------------------------------------------------
//
// 目标是 lex.js 那套项（字符类原语 + set/not/seq/or/*/+/?）。中间形态：
//   {t:'lit', s}          照原样比的一段文本
//   {t:'cls', n}          space nl digit alpha alnum hex any 之一
//   {t:'set', s, neg}     属于/不属于这几个字符
//   {t:'or', parts}       parts 是若干条「项数组」
//   {t:'rep', op, items}  op 是 * + ?，items 是被重复的那一串
//   {t:'seq', items}      只在 or 的分支里需要（渲染时才决定要不要它）

class Rx {
  constructor(re, file, diags, base) {
    this.re = re;
    this.i = 0;
    this.file = file;
    this.diags = diags;
    this.base = base;
    this.bad = false;
  }

  err(msg) {
    const at = this.base + this.i;
    this.diags.error(mkSpan(this.file, at, at < this.file.text.length ? at + 1 : at), `${msg}（在正则 ${q(this.re)} 里）`);
    this.bad = true;
  }

  eof() {
    return this.i >= this.re.length;
  }

  at(k) {
    return this.re.slice(this.i + (k === undefined ? 0 : k), this.i + (k === undefined ? 0 : k) + 1);
  }
}

/** 一段正则 -> 一串词法项。看不懂就记诊断并返回 null。 */
function compileRegex(re, file, diags, base) {
  const rx = new Rx(re, file, diags, base);
  const items = parseAltR(rx);
  /* 已经报过一句就别再补一句"多出来的 X" —— 那是**同一处**错的回声，不是第二处错 */
  if (!rx.eof() && !rx.bad) rx.err(`多出来的 ${q(rx.at())}`);
  return rx.bad ? null : items;
}

function parseAltR(rx) {
  const first = parseSeqR(rx);
  if (rx.at() !== '|') return first;
  const parts = [first];
  while (rx.at() === '|') {
    rx.i++;
    parts.push(parseSeqR(rx));
  }
  return [{ t: 'or', parts }];
}

function parseSeqR(rx) {
  const items = [];
  while (!rx.eof() && rx.at() !== '|' && rx.at() !== ')') {
    const got = parsePostfixR(rx);
    if (rx.bad) return items;
    for (const x of got) items.push(x);
  }
  return mergeLits(items);
}

/** 挨着的、没带量词的字面量并成一段 —— 只为了转出来的东西人能读 */
function mergeLits(items) {
  const out = [];
  for (const x of items) {
    const last = out.length === 0 ? null : out[out.length - 1];
    if (x.t === 'lit' && last !== null && last.t === 'lit') out[out.length - 1] = { t: 'lit', s: last.s + x.s };
    else out.push(x);
  }
  return out;
}

function parsePostfixR(rx) {
  const inner = parseAtomR(rx);
  if (rx.bad) return [];
  const c = rx.at();
  if (c !== '*' && c !== '+' && c !== '?') {
    return inner.length === 1 ? inner : [{ t: 'seq', items: inner }];
  }
  rx.i++;
  if (rx.at() === '?' || rx.at() === '+') {
    rx.err('不支持非贪心/占有量词（块注释那一种写成 %skip 会被认出来）');
    return [];
  }
  return [{ t: 'rep', op: c, items: inner }];
}

/** 一个原子。返回**一串**项：分组要保持"被量词整体重复"，所以不折成一个。 */
function parseAtomR(rx) {
  const c = rx.at();
  if (c === '(') {
    rx.i++;
    if (rx.re.startsWith('?:', rx.i)) rx.i += 2;
    else if (rx.at() === '?') { rx.err('不支持 (?=…) / (?!…) / (?<…>…) 这一族'); return []; }
    const items = parseAltR(rx);
    if (rx.at() !== ')') { rx.err('分组没有收尾的 )'); return []; }
    rx.i++;
    return items;
  }
  if (c === '[') return parseClassR(rx);
  if (c === ']' || c === ')') { rx.err(`多出来的 ${q(c)}`); return []; }
  if (c === '.') { rx.i++; return [{ t: 'cls', n: 'any' }]; }
  if (c === '*' || c === '+' || c === '?') { rx.err(`量词 ${q(c)} 前面没有东西`); return []; }
  if (c === '{') {
    // `{2,3}` 那一族不收；别处的 `{` 就是个普通字符（`%lex LBRACE \{` 是写好的那种）
    if (/^\{[0-9]+(,[0-9]*)?\}/.test(rx.re.slice(rx.i))) { rx.err('不支持 {n,m}'); return []; }
    rx.i++;
    return [{ t: 'lit', s: '{' }];
  }
  if (c === '\\') {
    const cls = classEscape(rx.at(1));
    if (cls !== null) {
      if (cls === '?') { rx.err(`不支持 ${q(`\\${rx.at(1)}`)}（取反的字符类只能写在 [^…] 里）`); return []; }
      rx.i += 2;
      return cls === 'w' ? [{ t: 'or', parts: [[{ t: 'cls', n: 'alnum' }], [{ t: 'lit', s: '_' }]] }] : [{ t: 'cls', n: cls }];
    }
    if (rx.at(1) === 'b' || rx.at(1) === 'B') { rx.err('`\\b` 只认「整个模式就是一个词」那一种（转成一条 punct）'); return []; }
    const d = unescapeAt(rx.re, rx.i);
    rx.i = d.end;
    return [{ t: 'lit', s: d.text }];
  }
  // `^` 与 `$` 在这儿是普通字符（见文件头第二条定义）
  rx.i++;
  return [{ t: 'lit', s: c }];
}

/** `\s \d \w` -> 类名；`\S \D \W` -> `'?'`（不收）；别的 -> null（当转义字符处理）。 */
function classEscape(ch) {
  if (ch === 's') return 'space';
  if (ch === 'd') return 'digit';
  if (ch === 'w') return 'w';
  if (ch === 'S' || ch === 'D' || ch === 'W') return '?';
  return null;
}

/**
 * `[…]`。范围先攒着，最后**尽量折成类名** —— `[a-zA-Z0-9_]` 折成 `(or alnum "_")`
 * 而不是摊成 63 个字符，转出来的东西才有人愿意读。折不动的范围才摊开。
 */
function parseClassR(rx) {
  rx.i++;
  const neg = rx.at() === '^';
  if (neg) rx.i++;
  let escs = '';
  let chars = '';
  let ranges = [];
  const addChar = (ch) => { if (!chars.includes(ch)) chars += ch; };
  while (!rx.eof() && rx.at() !== ']') {
    let lo = null;
    if (rx.at() === '\\') {
      const cls = classEscape(rx.at(1));
      if (cls !== null) { escs += rx.at(1); rx.i += 2; continue; }
      const d = unescapeAt(rx.re, rx.i);
      lo = d.text;
      rx.i = d.end;
    } else {
      lo = rx.at();
      rx.i++;
    }
    // `a-z`（`-` 在末尾时是普通字符）
    if (rx.at() === '-' && rx.at(1) !== ']' && rx.at(1) !== '') {
      rx.i++;
      let hi = null;
      if (rx.at() === '\\') { const d = unescapeAt(rx.re, rx.i); hi = d.text; rx.i = d.end; } else { hi = rx.at(); rx.i++; }
      ranges.push([lo.charCodeAt(0), hi.charCodeAt(0)]);
      continue;
    }
    addChar(lo);
  }
  if (rx.eof()) { rx.err('字符类没有收尾的 ]'); return []; }
  rx.i++;

  // `[\s\S]` / `[\d\D]` / `[\w\W]` 就是"任何字符"
  const bothWays = (a, b) => escs.includes(a) && escs.includes(b);
  if (bothWays('s', 'S') || bothWays('d', 'D') || bothWays('w', 'W')) return [{ t: 'cls', n: 'any' }];
  if (escs.includes('S') || escs.includes('D') || escs.includes('W')) {
    rx.err('字符类里不收 \\S / \\D / \\W');
    return [];
  }
  const classes = [];
  if (escs.includes('s')) classes.push('space');
  if (escs.includes('d')) classes.push('digit');
  if (escs.includes('w')) { classes.push('alnum'); addChar('_'); }

  if (neg) {
    if (classes.length > 0) { rx.err('取反的字符类里不收 \\s / \\d / \\w'); return []; }
    for (const r of ranges) for (let cc = r[0]; cc <= r[1]; cc++) addChar(String.fromCharCode(cc));
    if (chars === '') { rx.err('空的取反字符类'); return []; }
    return [{ t: 'set', s: chars, neg: true }];
  }

  // 认得出来的几组范围折成类名。次序有讲究：alnum 比 alpha 长，hex 比 digit 长。
  const take = (...want) => {
    for (const w of want) if (findRange(ranges, w[0], w[1]) < 0) return false;
    for (const w of want) ranges = dropRange(ranges, w[0], w[1]);
    return true;
  };
  const AZ = [65, 90];
  const az = [97, 122];
  const d09 = [48, 57];
  if (take(az, AZ, d09)) classes.push('alnum');
  else if (take(az, AZ)) classes.push('alpha');
  else if (take(d09, [97, 102], [65, 70])) classes.push('hex');
  else if (take(d09)) classes.push('digit');
  for (const r of ranges) for (let cc = r[0]; cc <= r[1]; cc++) addChar(String.fromCharCode(cc));

  const parts = [];
  for (const c of classes) parts.push({ t: 'cls', n: c });
  if (chars.length === 1) parts.push({ t: 'lit', s: chars });
  else if (chars.length > 1) parts.push({ t: 'set', s: chars, neg: false });
  if (parts.length === 0) { rx.err('空的字符类'); return []; }
  if (parts.length === 1) return parts;
  return [{ t: 'or', parts: parts.map((p) => [p]) }];
}

function findRange(ranges, lo, hi) {
  for (let i = 0; i < ranges.length; i++) if (ranges[i][0] === lo && ranges[i][1] === hi) return i;
  return -1;
}

function dropRange(ranges, lo, hi) {
  const out = [];
  let dropped = false;
  for (const r of ranges) {
    if (!dropped && r[0] === lo && r[1] === hi) { dropped = true; continue; }
    out.push(r);
  }
  return out;
}

// ---- 3) 词法项 -> 文本 -------------------------------------------------------

function renderTerms(items) {
  return items.map(renderTerm).join(' ');
}

function renderTerm(t) {
  if (t.t === 'lit') return q(t.s);
  if (t.t === 'cls') return t.n;
  if (t.t === 'set') return `(${t.neg ? 'not' : 'set'} ${q(t.s)})`;
  if (t.t === 'rep') return `(${t.op} ${renderTerms(t.items)})`;
  if (t.t === 'seq') return `(seq ${renderTerms(t.items)})`;
  return `(or ${t.parts.map(renderBranch).join(' ')})`;
}

/** or 的一条分支：一项就是一项，多项才要 `(seq …)` 把它们裹起来 */
function renderBranch(items) {
  return items.length === 1 ? renderTerm(items[0]) : `(seq ${renderTerms(items)})`;
}

// ---- 4) 两个形状的识别 -------------------------------------------------------

/**
 * 整个模式就是一段**文本**吗（末尾允许一个 `\b`）。是的话答那段文本 ——
 * 那就该转成一条 `(punct TYPE "文本")`，而不是一条带模式的 token 规则。
 */
function plainLiteralOf(re) {
  let out = '';
  let i = 0;
  const src = re.endsWith('\\b') ? re.slice(0, re.length - 2) : re;
  while (i < src.length) {
    const c = src.slice(i, i + 1);
    if (c === '\\') {
      const cls = classEscape(src.slice(i + 1, i + 2));
      if (cls !== null || src.slice(i + 1, i + 2) === 'b' || src.slice(i + 1, i + 2) === 'B') return null;
      const d = unescapeAt(src, i);
      out += d.text;
      i = d.end;
      continue;
    }
    if ('.*+?()[]|'.includes(c)) return null;
    if (c === '{' && /^\{[0-9]+(,[0-9]*)?\}/.test(src.slice(i))) return null;
    out += c;
    i++;
  }
  return out === '' ? null : out;
}

/**
 * `前缀 [任何]*? 后缀` —— 块注释那一个形状。非贪心是我们的匹配器唯一表达不了的东西
 * （它贪心且不回溯），而"扫到第一个后缀为止"正好就是 `(block-comment 开 关)`。
 * 认不出来就答 null，让通用那条路去报"不支持非贪心"。
 */
function blockCommentOf(re) {
  const at = re.indexOf('*?');
  if (at < 0) return null;
  let start = -1;
  if (re.slice(at - 1, at) === '.') start = at - 1;
  else if (re.slice(at - 1, at) === ']') {
    const open = re.lastIndexOf('[', at - 1);
    const inner = open < 0 ? '' : re.slice(open, at);
    if (inner !== '[\\s\\S]' && inner !== '[\\S\\s]') return null;
    start = open;
  }
  if (start < 0) return null;
  const open = plainLiteralOf(re.slice(0, start));
  const close = plainLiteralOf(re.slice(at + 2));
  if (open === null || close === null) return null;
  return { open, close };
}

// ---- 5) 声明段 ---------------------------------------------------------------

/** 这些指令只影响生成出来的 C 代码，对语言本身没有说法 —— 认得，然后丢掉。 */
const IGNORED_FLAGS = new Set(['glr-parser', 'locations', 'debug', 'verbose', 'header', 'defines',
  'no-lines', 'pure-parser', 'error-verbose', 'token-table', 'no-default-prec', 'default-prec',
  'fixed-output-files', 'yacc', 'nondeterministic-parser', 'raw']);
/** 后面跟一个字符串（或名字）的那些 */
const IGNORED_STR = new Set(['language', 'require', 'skeleton', 'name-prefix', 'output',
  'file-prefix', 'api-prefix']);
/** 后面跟一段 `{ … }` 的那些（前面可能还有一个限定名/串） */
const IGNORED_BLOCK = new Set(['union', 'code', 'initial-action', 'parse-param', 'lex-param',
  'param', 'destructor', 'printer', 'before-definitions', 'after-definitions']);

function symOf(t, g, sc) {
  if (t.k === 'id') { declTerm(g, t.v); return t.v; }
  if (t.k === 'lit') return declTerm(g, q(t.v));
  if (t.k === 'str') { const a = g.aliasOf.get(t.v); return a === undefined ? declTerm(g, q(t.v)) : a; }
  sc.err(t.at, `expected a symbol, got ${t.k === 'eof' ? 'end of file' : q(t.v)}`);
  return null;
}

/** 记一个终结符（幂等）。答它的内部名 —— 字面量的内部名就是转出来的那段文本。 */
function declTerm(g, name) {
  if (!g.termSet.has(name)) { g.termSet.add(name); g.terms.push(name); }
  return name;
}

const SYM_KINDS = new Set(['id', 'lit', 'str', 'num', '<']);

/**
 * bison 的 `_("…")`：可翻译的别名（`%token NUM _("number")`）。认出来就当普通别名收。
 * 答 true 表示"这一格吃掉了"。
 */
function takeI18nAlias(sc, g, last) {
  if (!(sc.peek().k === 'id' && sc.peek().v === '_' && sc.peek(1).k === '(')) return false;
  sc.next();
  sc.next();
  const s = sc.next();
  if (s.k === 'str' && last !== null) g.aliasOf.set(s.v, last);
  if (sc.peek().k === ')') sc.next();
  return true;
}

function parseDecls(sc, g) {
  for (;;) {
    const t = sc.next();
    if (t.k === 'eof' || t.k === '%%') return;
    if (t.k === 'prologue' || t.k === ';' || t.k === 'bad') continue;
    if (t.k !== '%') { sc.err(t.at, `expected a %-directive or %%, got ${q(t.v)}`); continue; }
    const d = t.v;

    // 终结符：`%token <tag> A 258 "别名" _("i18n 别名") B 'c'`
    if (d === 'token' || d === 'term') {
      let last = null;
      for (;;) {
        if (takeI18nAlias(sc, g, last)) continue;
        if (!SYM_KINDS.has(sc.peek().k)) break;
        const s = sc.next();
        if (s.k === '<' || s.k === 'num') continue;   // 类型标签 / 记号编号：对语言没说法
        if (s.k === 'str' && last !== null) { g.aliasOf.set(s.v, last); continue; }
        last = symOf(s, g, sc);
      }
      continue;
    }
    // 非终结符的类型标注：名字**不能**当成终结符收进来
    if (d === 'type' || d === 'nterm') {
      while (SYM_KINDS.has(sc.peek().k)) sc.next();
      continue;
    }
    // 优先级：一条声明一级，从低到高 —— 与我们的 `(prec …)` 逐条对应
    if (d === 'left' || d === 'right' || d === 'nonassoc' || d === 'precedence') {
      /* bison 的 `%precedence` 是「有优先级、不谈结合性」。我们的表只有三种结合性，
       * 落成 nonassoc：两者对「移进还是归约」的判断一致，差别只在同级同符号相邻时
       * nonassoc 会当错误 —— 而那正是 `%precedence` 那种符号本来不该出现的形状。 */
      const assoc = d === 'precedence' ? 'nonassoc' : d;
      const syms = [];
      for (;;) {
        if (takeI18nAlias(sc, g, syms.length === 0 ? null : syms[syms.length - 1])) continue;
        if (!SYM_KINDS.has(sc.peek().k)) break;
        const s = sc.next();
        if (s.k === '<' || s.k === 'num') continue;
        const nm = symOf(s, g, sc);
        if (nm !== null) { syms.push(nm); g.precSyms.add(nm); }
      }
      g.precLevels.push({ assoc, syms });
      continue;
    }
    if (d === 'start') {
      const s = sc.next();
      if (s.k !== 'id') sc.err(s.at, '%start needs a nonterminal name');
      else g.start = s.v;
      continue;
    }
    if (d === 'expect' || d === 'expect-rr') {
      if (sc.peek().k === 'num') sc.next();
      continue;
    }
    if (d === 'define') {
      if (sc.peek().k === 'id' || sc.peek().k === 'str') sc.next();
      const v = sc.peek().k;
      if (v === 'id' || v === 'str' || v === 'num' || v === '{') sc.next();
      continue;
    }
    if (IGNORED_BLOCK.has(d)) {
      if (sc.peek().k === 'id' || sc.peek().k === 'str' || sc.peek().k === '<') sc.next();
      // `%param {yyscan_t s}{result *r}` —— 一条指令上挂几段都算它的
      while (sc.peek().k === '{') sc.next();
      // `%destructor { … } A B 'c'` 后面还挂着一串符号
      while (SYM_KINDS.has(sc.peek().k)) sc.next();
      continue;
    }
    if (IGNORED_STR.has(d)) {
      if (sc.peek().k === 'str' || sc.peek().k === 'id') sc.next();
      continue;
    }
    if (IGNORED_FLAGS.has(d)) continue;

    // ---- 混合方言那两条：词法也写在这一份文件里
    if (d === 'skip' || d === 'lex') {
      const s = sc.next();
      if (s.k !== 'id') { sc.err(s.at, `%${d} needs a token name`); continue; }
      const line = sc.restOfLine();
      if (line.text === '') { sc.err(s.at, `%${d} ${s.v} has no pattern`); continue; }
      lexItemOf(sc, g, d, s.v, line.text, line.at);
      continue;
    }
    sc.err(t.at, `unknown directive %${d}`);
  }
}

/** 一条 `%skip` / `%lex` 落成 `(lex …)` 里的一行。 */
function lexItemOf(sc, g, d, name, re, at) {
  const blk = blockCommentOf(re);
  if (blk !== null) {
    // 块注释只有"跳过"这一种落法（我们的词法器没有起始条件）
    if (d !== 'skip') { sc.err(at, `%lex ${name}: 非贪心的形状只能当跳过的东西（写成 %skip）`); return; }
    g.lexItems.push(`(block-comment ${q(blk.open)} ${q(blk.close)})    ;; ${name}`);
    return;
  }
  const plain = plainLiteralOf(re);
  if (plain !== null) {
    if (d === 'skip') g.lexItems.push(`(skip ${q(plain)})    ;; ${name}`);
    else { declTerm(g, name); g.lexItems.push(`(punct ${name} ${q(plain)})`); }
    return;
  }
  const terms = compileRegex(re, sc.file, sc.diags, at);
  if (terms === null || terms.length === 0) return;
  if (d === 'skip') g.lexItems.push(`(skip ${renderTerms(terms)})    ;; ${name}`);
  else { declTerm(g, name); g.lexItems.push(`(token ${name} ${renderTerms(terms)})`); }
}

// ---- 6) 规则段 ---------------------------------------------------------------

/** `{ 一个名字 }` 的动作出那个名字；C 代码那种答 null（标签就用左部的名字）。 */
function tagOf(body) {
  const s = body.trim();
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s) ? s : null;
}

function parseRules(sc, g) {
  for (;;) {
    const t = sc.next();
    /* 第二个 `%%` 之后是尾声（C 代码），整段丢 */
    if (t.k === 'eof' || t.k === '%%') return;
    if (t.k === ';' || t.k === 'bad') continue;
    if (t.k !== 'id') { sc.err(t.at, `expected a nonterminal name, got ${t.k === '%' ? `%${t.v}` : q(t.v)}`); continue; }
    const c = sc.next();
    if (c.k !== ':') { sc.err(c.at, `expected ':' after '${t.v}'`); continue; }
    if (!g.rules.has(t.v)) { g.rules.set(t.v, []); g.lhsOrder.push(t.v); }
    for (;;) {
      g.rules.get(t.v).push(parseAlt(sc, g));
      if (sc.peek().k === '|') { sc.next(); continue; }
      if (sc.peek().k === ';') sc.next();
      break;
    }
  }
}

/**
 * 一条候选式。收到 `|` / `;` / 文件尾 / `%%` 为止，另外「下一个是 `名字 :`」也算收
 * —— bison 里那个 `;` 是可省的。
 *
 * 中段动作（`a { … } b`）在 bison 里会长出一个空的匿名非终结符；那件事**不改变语言**，
 * 所以这儿直接丢，只留最后一个动作的名字。
 */
function parseAlt(sc, g) {
  const rhs = [];
  let prec = null;
  let dprec = null;
  let tag = null;
  for (;;) {
    const t = sc.peek();
    if (t.k === '|' || t.k === ';' || t.k === 'eof' || t.k === '%%') break;
    if (t.k === 'id' && sc.peek(1).k === ':') break;
    sc.next();
    if (t.k === 'id' || t.k === 'lit' || t.k === 'str') {
      const nm = t.k === 'id' ? t.v : symOf(t, g, sc);
      if (nm !== null) rhs.push(nm);
      continue;
    }
    if (t.k === '[' || t.k === '<' || t.k === 'bad') continue;
    if (t.k === '{') { tag = tagOf(t.v); continue; }
    if (t.k !== '%') { sc.err(t.at, `unexpected ${q(t.v)} in a right-hand side`); continue; }
    if (t.v === 'empty') continue;
    if (t.v === 'prec') { prec = symOf(sc.next(), g, sc); continue; }
    if (t.v === 'dprec') {
      const n = sc.next();
      if (n.k !== 'num') sc.err(n.at, '%dprec needs an integer');
      else dprec = n.v;
      continue;
    }
    if (t.v === 'merge') { if (sc.peek().k === '<') sc.next(); continue; }
    sc.err(t.at, `unknown directive %${t.v} inside a rule`);
  }
  return { rhs, prec, dprec, tag };
}

// ---- 7) 转出 `(grammar …)` 文本 ----------------------------------------------

/** 长列表按列宽折行。转出来的东西是给人读的，一行两百个 token 不算给人读。 */
function wrapped(indent, open, items, close) {
  const lines = [];
  /* 续行对齐到第一项那一列（`repeat` 不在封闭 ABI 里，所以拿循环拼） */
  let cont = indent;
  for (let i = 0; i < open.length; i++) cont += ' ';
  let cur = `${indent}${open}`;
  for (const it of items) {
    if (cur.length + 1 + it.length > 100 && cur !== `${indent}${open}` && cur !== cont) { lines.push(cur); cur = cont; }
    cur += ` ${it}`;
  }
  lines.push(`${cur}${close}`);
  return lines;
}

function emitGrammar(g) {
  const out = [];
  out.push(`;; 这份 (grammar …) 是从 ${g.from} 转出来的（omni glr y）—— 要改的是那份 .y，不是这儿。`);
  out.push(`;; 动作只留名字：一条产生式一个节点，子节点按 RHS 位置排（见 glr/yacc.js 头部）。`);
  out.push(`(grammar ${g.name}`);
  if (g.terms.length > 0) for (const l of wrapped('  ', '(tokens', g.terms, ')')) out.push(l);
  for (const lv of g.precLevels) {
    if (lv.syms.length > 0) for (const l of wrapped('  ', `(prec ${lv.assoc}`, lv.syms, ')')) out.push(l);
  }
  out.push(`  (start ${g.start})`);
  if (g.lexItems.length > 0) {
    out.push('  (lex');
    for (const it of g.lexItems) out.push(`    ${it}`);
    out.push(`${out.pop()})`);
  }
  for (const lhs of g.lhsOrder) {
    out.push(`  (rule ${lhs}`);
    for (const alt of g.rules.get(lhs)) {
      const holes = [];
      for (let i = 0; i < alt.rhs.length; i++) holes.push(` $${i + 1}`);
      const notes = `${alt.prec !== null && g.precSyms.has(alt.prec) ? ` (prec ${alt.prec})` : ''}${alt.dprec === null ? '' : ` (prefer ${alt.dprec})`}`;
      out.push(`    (-> (${alt.rhs.join(' ')})${notes} (${alt.tag === null ? lhs : alt.tag}${holes.join('')}))`);
    }
    out.push(`${out.pop()})`);
  }
  out.push(`${out.pop()})`);
  return `${out.join('\n')}\n`;
}

// ---- 8) 入口 -----------------------------------------------------------------

/** 文件名 -> 语法的名字。非名字字符换成下划线（`(grammar N …)` 的 N 是个原子）。 */
function grammarNameOf(path) {
  const slash = path.lastIndexOf('/');
  const base = slash < 0 ? path : path.slice(slash + 1);
  const dot = base.indexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  let out = '';
  for (let i = 0; i < stem.length; i++) {
    const cc = stem.charCodeAt(i);
    out += i === 0 ? (isNameHeadCC(cc) ? stem.slice(i, i + 1) : '_') : (isNameCC(cc) ? stem.slice(i, i + 1) : '_');
  }
  return out === '' ? 'y' : out;
}

/**
 * 一份 `.y` -> 我们那份 `(grammar …)` 文本。诊断记进 `diags`，出错答 null。
 *
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {string|null}
 */
export function yaccToGrammarText(file, diags) {
  const sc = new YScan(file, diags);
  const g = {
    from: file.path,
    name: grammarNameOf(file.path),
    terms: [],
    termSet: new Set(),
    aliasOf: new Map(),
    precLevels: [],
    precSyms: new Set(),
    start: null,
    lexItems: [],
    lhsOrder: [],
    rules: new Map(),
  };
  parseDecls(sc, g);
  parseRules(sc, g);
  // `%start` 可以不写：那时起始符号就是第一条产生式的左部（yacc 的规矩）
  if (g.start === null) g.start = g.lhsOrder.length > 0 ? g.lhsOrder[0] : null;
  if (g.start === null) {
    diags.error(mkSpan(file, 0, 0), 'this .y file has no rules at all');
    return null;
  }
  /* bison 内建的 `error` 记号：语法里用到就把它声明成终结符。词法器永远不发它，
   * 于是那几条候选式是死的 —— 但语言没变，而"少声明一个符号"会让整份语法读不进来。 */
  for (const lhs of g.lhsOrder) {
    for (const alt of g.rules.get(lhs)) {
      for (const s of alt.rhs) if (s === 'error' && !g.rules.has('error')) declTerm(g, s);
    }
  }
  return diags.hasErrors() ? null : emitGrammar(g);
}
