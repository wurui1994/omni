// ext/lua/tokens.js —— Lua 的**词法表**（驱动器在 src/core/frontend-engine/lexrules.js）
//
// 三条要点：
//   1. **关键字是词，不是特例**：`and`/`or`/`not` 在算符表里与 `+` 同一档（带 `prec`）。
//   2. **长括号（`[[…]]`、`--[==[…]==]`）是一条规则** —— 这一条是 Lua 特有的，所以写在这儿，
//      不在 SDK 的通用规则件里。
//   3. **算符查询要问 `kind`**：`{['+'] = 2}` 里那个 `'+'` 是字符串，不是加号（尺子抓过一次）。

import {
  LexError, reRule, nameRule, numberRule, symbolRule, quoted,
} from '../../src/core/frontend-engine/lexrules.js';

export { LexError };

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

