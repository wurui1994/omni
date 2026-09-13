// ext/lua/tokens.js —— 词法：**每类记号一条规则**，扫描器是读表的驱动器
//
// 规则表（`lang.tokens`）里一行 = 一类记号。一行有两种写法：
//
//   { re: /…/y }                 粘性正则（`y` 标志，从当前位置起匹配）
//   { take(src, i, ctx) }        自己认（长括号、带转义的字符串、最长匹配的符号）
//
// 另外两格：`skip: true`（空白与注释：认了但不产记号）、`kind`（产什么类的记号）。
//
// 为什么要做成表：`ext/gsl-shell` 的公式子语言词法与 Lua **完全不同**
// （`'…'` 是字面量、`[…]` 是标识符、名字里能有 `.` 和 `$`、没有注释）。它换一张表就行，
// 这一份一个字不用改。先前这些规则是写死的 if 分支，那就只能给 Lua 用。
//
// 三条要点：
//   1. **关键字是词，不是特例**：`and`/`or`/`not` 在算符表里与 `+` 同一档（带 `prec`）。
//   2. **长括号（`[[…]]`、`--[==[…]==]`）是一条规则**，不是解析器里的分支。
//   3. **算符查询必须问 `kind`**：`{['+'] = 2}` 里那个 `'+'` 是字符串，不是加号 ——
//      先前只比 `value`，语料里 20 个文件因此不认（`expr-lexer.lua:11` 那种表）。

/** 保留词（不是算符的那些）。算符关键字在 LUA_OPS 里，带优先级。 */
export const LUA_KEYWORDS = [
  'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'repeat', 'return', 'then', 'true', 'until', 'while',
];

/**
 * 算符表。一行 = 一个记号：
 *   `prec` 有值 → 它能当**二元**算符（`assoc` 说左结合还是右结合）
 *   `unary`     → 它也能当**前缀**算符（一元同档，见 LUA_UNARY_PREC）
 * 档次照 Lua 5.1 的 `priority[]`（lparser.c）：or < and < 比较 < .. < + - < * / % < 一元 < ^
 */
export const LUA_OPS = [
  { name: 'or', word: true, prec: 1, assoc: 'left' },
  { name: 'and', word: true, prec: 2, assoc: 'left' },
  { name: '<', prec: 3, assoc: 'left' },
  { name: '>', prec: 3, assoc: 'left' },
  { name: '<=', prec: 3, assoc: 'left' },
  { name: '>=', prec: 3, assoc: 'left' },
  { name: '~=', prec: 3, assoc: 'left' },
  { name: '==', prec: 3, assoc: 'left' },
  { name: '..', prec: 4, assoc: 'right' },
  { name: '+', prec: 5, assoc: 'left' },
  { name: '-', prec: 5, assoc: 'left', unary: true },
  { name: '*', prec: 6, assoc: 'left' },
  { name: '/', prec: 6, assoc: 'left' },
  { name: '%', prec: 6, assoc: 'left' },
  { name: '^', prec: 8, assoc: 'right' },
  { name: 'not', word: true, unary: true },
  { name: '#', unary: true },
];

/** 一元算符的档：比 `*` 高、比 `^` 低（`-x^2` 是 `-(x^2)`，`(-x)^2` 要括号）。 */
export const LUA_UNARY_PREC = 7;

/** 标点。最长匹配由 lang.js 按长度倒排保证，这儿不管次序。 */
export const LUA_PUNCT = ['...', '::', '..', '<=', '>=', '~=', '==', '{', '}', '(', ')', '[', ']',
  ';', ':', ',', '.', '='];

/**
 * 记号能不能当算符看。词算符（`and`/`or`/`not`）要 `word`，符号算符要 `op`；
 * `name`/`string`/`number` 一律不是算符。
 */
function opOf(tok, lang) {
  if (tok === undefined) return undefined;
  const o = lang.OP.get(tok.value);
  if (o === undefined) return undefined;
  const want = o.word === true ? 'word' : 'op';
  return tok.kind === want ? o : undefined;
}

/** 二元算符查询：给一个记号，答 `{prec, assoc}` 或 undefined。优先级爬升要它。 */
export function binop(tok, lang) {
  const o = opOf(tok, lang);
  return o === undefined || o.prec === undefined ? undefined : o;
}

/** 前缀算符查询。 */
export function unop(tok, lang) {
  const o = opOf(tok, lang);
  return o === undefined || o.unary !== true ? undefined : o;
}

export class LexError extends Error {
  constructor(msg, line) {
    super(`${line} 行：${msg}`);
    this.name = 'LexError';
    this.line = line;
  }
}

// ── 通用的规则件（各语言拼自己的表用）─────────────────────────────────────────

/** 粘性正则：从 `i` 起匹配。 */
const at = (re, src, i) => {
  re.lastIndex = i;
  return re.exec(src);
};

/**
 * 长括号：`[` + n 个 `=` + `[` … `]` + n 个 `=` + `]`。`open` 说从哪儿开始看。
 * 答 `{text, end}` 或 null。
 */
export function longBracket(src, open) {
  if (src[open] !== '[') return null;
  let i = open + 1;
  let level = 0;
  while (src[i] === '=') { level += 1; i += 1; }
  if (src[i] !== '[') return null;
  i += 1;
  if (src[i] === '\n') i += 1;                 // 紧跟的第一个换行不算内容（手册 §2.1）
  const close = `]${'='.repeat(level)}]`;
  const end = src.indexOf(close, i);
  if (end < 0) return { unclosed: true };
  return { text: src.slice(i, end), end: end + close.length };
}

const ESC = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n',
};

/** 带转义的短字符串（Lua 那套）。答 `{text, end}` 或 null。 */
export function quoted(src, open, line) {
  const q = src[open];
  if (q !== '"' && q !== "'") return null;
  let i = open + 1;
  let out = '';
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\n') throw new LexError('字符串里不能直接换行', line);
    if (src[i] === '\\') {
      const c = src[i + 1];
      if (c >= '0' && c <= '9') {                 // \ddd（最多三位十进制）
        let d = '';
        i += 1;
        while (d.length < 3 && src[i] >= '0' && src[i] <= '9') { d += src[i]; i += 1; }
        out += String.fromCharCode(Number(d));
        continue;
      }
      if (ESC[c] === undefined) throw new LexError(`不认得的转义 \\${c}`, line);
      out += ESC[c];
      i += 2;
      continue;
    }
    out += src[i];
    i += 1;
  }
  if (i >= src.length) throw new LexError('字符串没关上', line);
  return { text: out, end: i + 1 };
}

/** 名字/保留词。`kind` 由语言的关键字表与算符表定（`word` 还是 `name`）。 */
export const nameRule = (re) => ({
  name: 'name',
  take: (src, i, ctx) => {
    const m = at(re, src, i);
    if (m === null) return null;
    const w = m[0];
    const kind = ctx.lang.keywordSet.has(w) || ctx.lang.opNames.has(w) ? 'word' : 'name';
    return { value: w, end: i + w.length, kind };
  },
});

/** 后缀正则要编成**粘性**的：`^` 在粘性正则里只认字符串开头，所以先把它去掉。 */
const stickyCache = new Map();
const sticky = (re) => {
  let s = stickyCache.get(re);
  if (s === undefined) {
    s = new RegExp(re.source.replace(/^\^/, ''), 'y');
    stickyCache.set(re, s);
  }
  return s;
};

/** 数字。`lang.numSuffix` 说后缀（LuaJIT 的 `1i`/`LL`…）。 */
export const numberRule = (re) => ({
  name: 'number',
  kind: 'number',
  take: (src, i, ctx) => {
    const m = at(re, src, i);
    if (m === null) return null;
    let text = m[0];
    const suf = ctx.lang.numSuffix === undefined
      ? null : at(sticky(ctx.lang.numSuffix), src, i + text.length);
    if (suf !== null) text += suf[0];
    return { value: text, end: i + text.length };
  },
});

/** 符号（标点与符号算符）：拿 `lang.symbols`（已按长度倒排）做最长匹配。 */
export const symbolRule = () => ({
  name: 'symbol',
  take: (src, i, ctx) => {
    const hit = ctx.lang.symbols.find((s) => src.startsWith(s, i));
    if (hit === undefined) return null;
    return { value: hit, end: i + hit.length, kind: ctx.lang.opNames.has(hit) ? 'op' : 'punct' };
  },
});

/** 一条正则规则（空白、简单形状的记号）。 */
export const reRule = (name, re, extra = {}) => ({ name, re, ...extra });

// ── Lua 的记号表 ────────────────────────────────────────────────────────────

const LUA_NUM = /0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][-+]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const LUA_NAME = /[A-Za-z_]\w*/y;

export const LUA_TOKENS = [
  reRule('space', /[ \t\r\n]+/y, { skip: true }),
  {
    name: 'comment',
    skip: true,
    take: (src, i, ctx) => {
      if (src[i] !== '-' || src[i + 1] !== '-') return null;
      const long = longBracket(src, i + 2);
      if (long !== null) {
        if (long.unclosed === true) throw new LexError('长注释没关上', ctx.line);
        return { value: '', end: long.end };
      }
      const nl = src.indexOf('\n', i);
      return { value: '', end: nl < 0 ? src.length : nl };
    },
  },
  {
    name: 'long-string',
    kind: 'string',
    take: (src, i, ctx) => {
      const l = longBracket(src, i);
      if (l === null) return null;
      if (l.unclosed === true) throw new LexError('长括号没关上', ctx.line);
      return { value: l.text, end: l.end };
    },
  },
  {
    name: 'string',
    kind: 'string',
    take: (src, i, ctx) => {
      const q = quoted(src, i, ctx.line);
      return q === null ? null : { value: q.text, end: q.end };
    },
  },
  numberRule(LUA_NUM),
  nameRule(LUA_NAME),
  symbolRule(),
];

/**
 * 扫描。答一串 `{kind, value, line}`；`kind` ∈ word|name|number|string|punct|op|eof。
 * **扫描器本身不认识任何语言** —— 规则表、关键字表、算符表、符号表全从 `lang` 来。
 */
export function lex(src, lang) {
  const rules = lang.tokens ?? LUA_TOKENS;
  const out = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    let hit = null;
    for (const r of rules) {
      if (r.re !== undefined) {
        const m = at(r.re, src, i);
        if (m === null) continue;
        hit = { r, value: m[0], end: i + m[0].length };
        break;
      }
      const t = r.take(src, i, { line, lang });
      if (t === null || t === undefined) continue;
      hit = { r, value: t.value, end: t.end, kind: t.kind };
      break;
    }
    if (hit === null) throw new LexError(`不认得的字符 '${src[i]}'`, line);
    if (hit.r.skip !== true) out.push({ kind: hit.kind ?? hit.r.kind ?? 'punct', value: hit.value, line });
    for (let k = i; k < hit.end; k += 1) if (src[k] === '\n') line += 1;
    i = hit.end;
  }
  out.push({ kind: 'eof', value: '<eof>', line });
  return out;
}
