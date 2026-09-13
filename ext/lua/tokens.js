// ext/lua/tokens.js —— 词法：**每类记号一条规则**，扫描器是读表的驱动器
//
// 设计（DESIGN.md 第 2 节）只有两条要点：
//
//   1. **关键字是词，不是特例**。`and` / `or` / `not` 在表里与 `+` 同一档（带 `prec`/`assoc`），
//      于是"关键字算符"不用在语法里另开一支 —— 二元算符那一条规则就把它们吃了。
//   2. **长括号是记号层的一条规则**。`[[…]]` / `[==[…]==]` 与 `--[==[…]==]` 共用同一条
//      `longBracket`，不是解析器里的分支。
//
// 出处：Lua 5.1 手册 §2.1（词法）与 LuaJIT 2 的 lj_lex.c；`goto`/`::label::` 是 5.2 的词，
// LuaJIT 2 收了，所以在表里（`since: '5.2'`）。

/** 保留词（不是算符的那些）。算符关键字在 OPS 里，带优先级。 */
export const LUA_KEYWORDS = [
  'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'repeat', 'return', 'then', 'true', 'until', 'while',
];

/**
 * 算符表。一行 = 一个记号：
 *   `prec` 有值 → 它能当**二元**算符（`assoc` 说左结合还是右结合）
 *   `unary`     → 它也能当**前缀**算符（一元优先级在 UNARY_PREC，Lua 里所有一元同档）
 * 档次照 Lua 5.1 的 `getbinopr`/`priority[]`（lparser.c）：
 *   or < and < 比较 < .. < + - < * / % < 一元 < ^
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

/** 标点（没有优先级的那些）。最长匹配由 lang.js 里按长度倒排保证，这儿不管次序。 */
export const LUA_PUNCT = ['...', '::', '..', '<=', '>=', '~=', '==', '{', '}', '(', ')', '[', ']',
  ';', ':', ',', '.', '='];

/**
 * 记号能不能当算符看。**这一格必须问 `kind`**：`{['+'] = 2}` 里那个 `'+'` 是**字符串**，
 * 不是加号 —— 先前只比 `value` 就把它当成了一元加号，gsl-shell 语料里 20 个文件因此不认
 * （`expr-lexer.lua:11`、`expr-print.lua:65`…）。词算符（`and`/`or`/`not`）要 `word`，
 * 符号算符要 `op`；`name`/`string`/`number` 一律不是算符。
 */
function opOf(tok, lang) {
  if (tok === undefined) return undefined;
  const o = lang.OP.get(tok.value);
  if (o === undefined) return undefined;
  const want = o.word === true ? 'word' : 'op';
  return tok.kind === want ? o : undefined;
}

/** 二元算符查询：给一个记号，答 `{prec, assoc}` 或 undefined。组合规则（爬优先级）要它。 */
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

/**
 * 长括号那一条规则：`[` 后面 n 个 `=` 再一个 `[`，直到 `]` + n 个 `=` + `]`。
 * `at` 指着开头那个 `[`。答 `{text, end}`，不是长括号则答 undefined。
 */
function longBracket(src, at) {
  if (src[at] !== '[') return undefined;
  let i = at + 1;
  let level = 0;
  while (src[i] === '=') { level += 1; i += 1; }
  if (src[i] !== '[') return undefined;
  i += 1;
  if (src[i] === '\n') i += 1;            // 紧跟的第一个换行不算内容（手册 §2.1）
  const close = `]${'='.repeat(level)}]`;
  const end = src.indexOf(close, i);
  if (end < 0) throw new LexError('长括号没关上', 1 + src.slice(0, at).split('\n').length - 1);
  return { text: src.slice(i, end), end: end + close.length };
}

/** 短字符串：引号 + 转义。答 `{text, end}`。 */
function quoted(src, at, line) {
  const q = src[at];
  let i = at + 1;
  let out = '';
  const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
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

const NUM = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/;
const NAME = /^[A-Za-z_]\w*/;

/**
 * 扫描。答一串 `{kind, value, line}`；`kind` ∈ word|name|number|string|punct|op|eof。
 * `word` 是保留词（含关键字算符），`op`/`punct` 是符号 —— 语法那边只问 `binop()`/`unop()`
 * 与 `value`，所以这两栏的分野只用来印诊断。
 *
 * `lang` 给三样：`keywordSet` / `opNames` / `symbols`（已按长度倒排），外加可选的
 * `numSuffix`（数字后缀的正则，gsl-shell 的虚数 `1i` 用它）。**扫描器本身不认识任何语言**。
 */
export function lex(src, lang) {
  const out = [];
  let i = 0;
  let line = 1;
  const bump = (s) => { for (const c of s) if (c === '\n') line += 1; };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '-' && src[i + 1] === '-') {                     // 注释：长括号或到行尾
      const long = i + 2 < src.length ? longBracket(src, i + 2) : undefined;
      if (long !== undefined) { bump(src.slice(i, long.end)); i = long.end; continue; }
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '[') {
      const long = longBracket(src, i);
      if (long !== undefined) {
        out.push({ kind: 'string', value: long.text, line });
        bump(src.slice(i, long.end));
        i = long.end;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const s = quoted(src, i, line);
      out.push({ kind: 'string', value: s.text, line });
      i = s.end;
      continue;
    }
    const rest = src.slice(i);
    const num = NUM.exec(rest);
    if (num !== null && (c === '.' ? /\d/.test(src[i + 1] ?? '') : /\d/.test(c))) {
      let text = num[0];
      const suf = lang.numSuffix === undefined ? null : lang.numSuffix.exec(rest.slice(text.length));
      if (suf !== null && suf !== undefined && suf.index === 0) text += suf[0];
      out.push({ kind: 'number', value: text, line });
      i += text.length;
      continue;
    }
    const nm = NAME.exec(rest);
    if (nm !== null) {
      const w = nm[0];
      const kind = lang.keywordSet.has(w) || lang.opNames.has(w) ? 'word' : 'name';
      out.push({ kind, value: w, line });
      i += w.length;
      continue;
    }
    const hit = lang.symbols.find((s) => rest.startsWith(s));
    if (hit === undefined) throw new LexError(`不认得的字符 '${c}'`, line);
    out.push({ kind: lang.opNames.has(hit) ? 'op' : 'punct', value: hit, line });
    i += hit.length;
  }
  out.push({ kind: 'eof', value: '<eof>', line });
  return out;
}
