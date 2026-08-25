// Omni stage0 — 词法分析
// 每个 token 携带 leading trivia（空白+注释）的原文，为将来的无损 CST / 格式化器留出通路。

import { span } from '../source/diag.js';

export const KEYWORDS = new Set([
  'int', 'real', 'bool', 'string', 'void', 'struct',
  'dynamic', 'json', 'list', 'dict', 'set', 'class', 'new', 'null', 'in',
  'if', 'else', 'while', 'for', 'return', 'break', 'continue',
  'true', 'false',
  // 省略类型的声明形态（ADR-0008）：let 块作用域，var 函数作用域
  'var', 'let',
]);

// 长的放前面，保证最长匹配
const PUNCT = [
  '<<=', '>>=',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
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
        if (v > 0x7fffffffffffffffn) diags.error(span(file, start, i), `integer literal out of int64 range: ${text}`);
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
