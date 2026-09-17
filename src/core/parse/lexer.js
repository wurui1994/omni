// Omni stage0 — 词法分析
// 每个 token 携带 leading trivia（空白+注释）的原文，为将来的无损 CST / 格式化器留出通路。

import { span } from '../source/diag.js';

// int64 的上界。写成十进制而不是 0x7fffffffffffffffn：十六进制的 bigint 字面量在降级之后
// 是 BigInt("0x…")，而这个值域的 int_of_string 只认十进制（自举时会当场报错）。
const INT64_MAX = 9223372036854775807n;

export const KEYWORDS = new Set([
  'int', 'real', 'bool', 'string', 'void', 'struct',
  'dynamic', 'json', 'list', 'dict', 'set', 'class', 'new', 'null', 'in',
  'if', 'else', 'while', 'for', 'return', 'break', 'continue',
  'true', 'false',
  // 省略类型的声明形态（ADR-0008）：let 块作用域，var 函数作用域
  'var', 'let',
  // 模块（ADR-0009）：import 引入另一个模块，private 把顶层名字挡在本模块内
  'import', 'private',
  // 函数值（ADR-0010）：`fn(int, int) -> int` 是类型，`fn(int x) -> int { ... }` 是 lambda
  'fn',
  // tagged union（ADR-0012）：`enum` 声明，`match` / `case` / `default` 解构
  'enum', 'match', 'case', 'default',
]);

// 长的放前面，保证最长匹配
const PUNCT = [
  '<<=', '>>=',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  // '->' 必须排在 '-' 前面，否则 `-> int` 会先切出一个减号
  '->',
  '(', ')', '{', '}', '[', ']', ';', ',', '.', '?', ':', '=', '+', '-', '*', '/', '%',
  '!', '<', '>', '&', '|', '^', '~',
];

const ESCAPES = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };

/** @typedef {{kind: string, text: string, value: any, span: import('../source/diag.js').Span, trivia: string}} Token */

/**
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {Token[]}
 */
export function lex(file, diags) {
  const src = file.text;
  const n = src.length;
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  /* `#lang <名字>`（ADR-0037）与 shebang：**只在第一行**，读到就整行跳过。
   *
   * 为什么词法这一层要认它：那一行是给**驱动**看的（决定这份文件交给哪台读入器，见
   * cli.js 的 `pickLang`），到了这儿它的活已经干完了。收下开关的地方在驱动那一层
   * （默认关着），所以这儿不判开关 —— 走到这里说明驱动已经放行了。
   * 只跳第一行：位置固定才有"一眼看得出这是什么"的价值，也不必扫整份文件。 */
  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') i++;
    if (i < n) i++;
  }
  {
    let j = i;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r' || src[j] === '\n')) j++;
    if (src.startsWith('#lang', j)) {
      i = j;
      while (i < n && src[i] !== '\n') i++;
    }
  }

  const push = (kind, start, value, trivia) => {
    tokens.push({ kind, text: src.slice(start, i), value, span: span(file, start, i), trivia });
  };

  while (true) {
    // --- trivia ---
    const triviaStart = i;
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const start = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        if (i >= n) diags.error(span(file, start, start + 2), 'unterminated block comment');
        else i += 2;
        continue;
      }
      break;
    }
    const trivia = src.slice(triviaStart, i);

    if (i >= n) { push('eof', i, null, trivia); break; }

    const start = i;
    const c = src[i];

    // --- identifier / keyword ---
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      const text = src.slice(start, i);
      if (text === 'true' || text === 'false') push('bool', start, text === 'true', trivia);
      else push(KEYWORDS.has(text) ? 'kw' : 'ident', start, text, trivia);
      continue;
    }

    // --- number ---
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9_]/.test(src[i])) i++;
      let isReal = false;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        isReal = true;
        i++;
        while (i < n && /[0-9_]/.test(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (/[0-9]/.test(src[i] ?? '')) {
          isReal = true;
          while (i < n && /[0-9]/.test(src[i])) i++;
        } else i = save;
      }
      const text = src.slice(start, i).replace(/_/g, '');
      if (isReal) push('real', start, Number(text), trivia);
      else {
        const v = BigInt(text);
        if (v > INT64_MAX) diags.error(span(file, start, i), `integer literal out of int64 range: ${text}`);
        push('int', start, v, trivia);
      }
      continue;
    }

    // --- string ---
    if (c === '"') {
      i++;
      let value = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\n') { diags.error(span(file, start, i), 'unterminated string literal'); break; }
        if (src[i] === '\\') {
          const e = src[i + 1];
          if (e in ESCAPES) { value += ESCAPES[e]; i += 2; continue; }
          diags.error(span(file, i, i + 2), `unknown escape sequence: \\${e ?? ''}`);
          i += 2;
          continue;
        }
        value += src[i++];
      }
      if (src[i] === '"') i++;
      else diags.error(span(file, start, i), 'unterminated string literal');
      push('str', start, value, trivia);
      continue;
    }

    // --- punctuation ---
    const p = PUNCT.find((op) => src.startsWith(op, i));
    if (p) {
      i += p.length;
      push('punct', start, p, trivia);
      continue;
    }

    i++;
    diags.error(span(file, start, i), `unexpected character: ${JSON.stringify(c)}`);
  }

  return tokens;
}
