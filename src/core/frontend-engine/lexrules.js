// src/core/frontend-engine/lexrules.js —— 词法：**每类记号一条规则**，扫描器读表
//
// 与任何具体语言无关（ADR-0030 第 2 节）。语言交两样：
//
//   lang.tokens   规则表。一行 = 一类记号，两种写法：
//                   { re: /…/y }              粘性正则（`y` 标志，从当前位置起匹配）
//                   { take(src, i, ctx) }     自己认（带转义的字符串、最长匹配的符号…）
//                 另加两格：`skip: true`（空白/注释：认了但不产记号）、`kind`（产哪一类）
//   lang.ops      算符表（`prec` / `assoc` / `unary` / `word` / `onlyAt`）
//
// 通用规则件在这儿备着：`reRule` / `nameRule` / `numberRule` / `symbolRule` / `quoted`。
// 某门语言特有的（Lua 的 `[[…]]` 长括号、gsl-shell 公式里的 `[…]` 标识符）写在它自己那边。

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
