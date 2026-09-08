// Omni stage0 — JS 语法前端：词法分析
//
// 为什么要有它：ADR-0001。js -> 解析 -> 生成 js 本身是恒等变换、没有用处，但它是前端唯一的
// **免费 oracle**（幂等 + 语义一致），而且它让 C 路径自举不需要先用 Omni 语法重写编译器。
// 这个前端是永久设施，不是自举脚手架。
//
// 支持的子集由 `src/core` 里实际写过的 JS 决定（见 docs/js-bootstrap-subset.md）：
// 没有 async/await、没有生成器、没有 do-while、没有标签、没有 delete、没有 with/eval。
// **不支持的语法必须报错**，绝不静默跳过 —— 静默跳过会让 bug 变成几万行生成 C 里的段错误。
//
// 两个真正需要小心的地方，别的都是照抄规范：
//   1. `/` 是除号还是正则的开头，只能靠**前一个有意义的 token** 判断。
//   2. 模板字符串里的 `${}` 可以嵌套模板，所以词法器必须自己维护一个栈。
// 另外每个 token 记 `nl`（它前面的 trivia 里有没有换行），ASI 全靠它。

import { span } from '../source/diag.js';

export const KEYWORDS_JS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'static', 'switch', 'this',
  'throw', 'try', 'typeof', 'var', 'void', 'while',
  // 生成器（ADR-0020 P2）：`yield` 进关键字表，`function*` 与 `yield*` 由解析器认。
  // `async` / `await` **不进**：它们在 JS 里是上下文相关的（可以当普通标识符），
  // 由解析器多问一句来认（parser.js 的 atWord / awaitAhead）。
  'yield',
]);

/**
 * 这三个词法上是关键字、语义上是字面量，单独成 token 类别。
 *
 * **用 Map 而不是对象字面量**：`'toString' in {null:null,...}` 是 true（`in` 会走原型链），
 * 于是 `x.toString(16)` 里的 `toString` 会被当成字面量、值还是 `Object.prototype.toString`
 * 那个函数本身。这个 bug 是 js 往返一致性测试抓出来的 —— 单看解析结果一切正常。
 * 同一个坑在下面的 SIMPLE_ESCAPES 上也堵住了。
 */
const LITERAL_WORDS = new Map([['null', null], ['true', true], ['false', false]]);

// 长的在前，保证最长匹配
const PUNCT_JS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '?', ':', '=',
  '+', '-', '*', '/', '%', '!', '~', '<', '>', '&', '|', '^',
];

/**
 * `/` 的歧义：只有当前一个有意义的 token **不能作为表达式的结尾** 时，`/` 才是正则的开头。
 * 反过来列（"能结尾"的集合）更短也更不容易漏：标识符、字面量、`)`、`]`、`}`、`++`、`--`。
 * 注意 `)` 这一项在 `if (x) /re/.test(y)` 上是错的 —— 那需要跟踪 `)` 属于哪种结构。
 * stage0 的源码里没有这种写法，先按简单规则走，并在解析阶段由"正则字面量出现在语句开头"
 * 这条约束兜住；真遇到了会报错，不会静默生成错的代码。
 */
function regexAllowed(prev) {
  if (!prev) return true;
  // bigint 也是字面量（`5n / 2n` 里那个 `/` 是除号）—— 漏了这一格的时候，`/ 2n, -7n %`
  // 被当成一个正则字面量吃掉，报的是"未终结的正则"（量出来的）
  if (prev.kind === 'num' || prev.kind === 'bigint' || prev.kind === 'str' || prev.kind === 'regex') return false;
  if (prev.kind === 'ident') return false;
  if (prev.kind === 'lit') return false;
  if (prev.kind === 'tmpl_tail' || prev.kind === 'tmpl_full') return false;
  if (prev.kind === 'kw') return !['this'].includes(prev.value);
  return !([')', ']', '}', '++', '--'].includes(prev.value));
}

const SIMPLE_ESCAPES = new Map([
  ['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f'], ['v', '\v'], ['0', '\0'],
]);
const RADIX = new Map([['x', 16], ['o', 8], ['b', 2]]);

/**
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 */
export function lexJs(file, diags) {
  const src = file.text;
  const n = src.length;
  /** @type {any[]} */
  const tokens = [];
  let i = 0;
  /** 模板栈：每一层记"回到模板文本"所对应的花括号深度 */
  const tmpl = [];
  let braces = 0;

  const err = (s, e, msg) => diags.error(span(file, s, e), msg);

  // hashbang 只在文件第一个字节合法（cli.js 就是可执行脚本）。当注释处理，但要留着原文：
  // 生成回去时丢了它，产物就不再是可执行文件。
  if (src.startsWith('#!')) while (i < n && src[i] !== '\n') i++;
  const hashbang = i > 0 ? src.slice(0, i) : null;

  const push = (kind, start, value, nl, extra) => {
    tokens.push({ kind, value, text: src.slice(start, i), span: span(file, start, i), nl, ...extra });
  };

  /** 读一个反斜杠转义，i 指向反斜杠。返回它代表的字符串（可能是空串：行接续） */
  const escape = () => {
    const start = i;
    i++; // 反斜杠
    const c = src[i];
    if (c === undefined) { err(start, i, 'unterminated escape sequence'); return ''; }
    if (c === '\n') { i++; return ''; }            // 行接续
    if (c === '\r') { i++; if (src[i] === '\n') i++; return ''; }
    if (SIMPLE_ESCAPES.has(c)) { i++; return SIMPLE_ESCAPES.get(c); }
    if (c === 'x') {
      const hex = src.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) { err(start, i + 3, 'invalid \\x escape'); i += 3; return ''; }
      i += 3;
      return String.fromCharCode(parseInt(hex, 16));
    }
    if (c === 'u') {
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i + 2);
        const hex = close < 0 ? '' : src.slice(i + 2, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) { err(start, close < 0 ? i + 2 : close + 1, 'invalid \\u{...} escape'); }
        i = close < 0 ? i + 2 : close + 1;
        return hex ? String.fromCodePoint(parseInt(hex, 16)) : '';
      }
      const hex = src.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) { err(start, i + 5, 'invalid \\u escape'); i += 5; return ''; }
      i += 5;
      return String.fromCharCode(parseInt(hex, 16));
    }
    i++;
    return c; // \" \' \` \\ \/ \$ 以及任何其它字符：就是它自己
  };

  /**
   * 从模板的开界符之后开始扫。`opened` 是 '`'（模板刚开始）或 '}'（从内插表达式回来）。
   * `cooked` 是转义处理后的值，`raw` 是原文 —— `String.raw` 要 raw，生成 js 也要 raw。
   */
  const scanTemplate = (start, opened) => {
    const rawStart = i;
    let cooked = '';
    while (i < n) {
      const c = src[i];
      if (c === '`') {
        const raw = src.slice(rawStart, i);
        i++;
        return { kind: opened === '`' ? 'tmpl_full' : 'tmpl_tail', cooked, raw };
      }
      if (c === '$' && src[i + 1] === '{') {
        const raw = src.slice(rawStart, i);
        i += 2;
        return { kind: opened === '`' ? 'tmpl_head' : 'tmpl_middle', cooked, raw };
      }
      if (c === '\\') { cooked += escape(); continue; }
      cooked += c;
      i++;
    }
    err(start, i, 'unterminated template literal');
    return { kind: opened === '`' ? 'tmpl_full' : 'tmpl_tail', cooked, raw: src.slice(rawStart, i) };
  };

  while (true) {
    // ---- trivia：空白与注释。只记"有没有换行"，ASI 全靠这一位 ----
    let nl = tokens.length === 0;
    for (;;) {
      const c = src[i];
      if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') { nl = true; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const s = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') nl = true; i++; }
        if (i >= n) err(s, s + 2, 'unterminated block comment');
        else i += 2;
        continue;
      }
      break;
    }
    if (i >= n) { push('eof', i, null, nl); break; }

    const start = i;
    const c = src[i];

    // ---- 标识符 / 关键字 / null,true,false ----
    // `#name` 也是一个标识符（ADR-0020 P4 的私有名）：井号留在名字里，于是 `this.#x`
    // 就是"成员名叫 #x"、`#m(){}` 就是"方法名叫 #m"，后面一路照普通属性走。
    if (/[A-Za-z_$]/.test(c) || (c === '#' && /[A-Za-z_$]/.test(src[i + 1] ?? ''))) {
      if (c === '#') i++;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
      const text = src.slice(start, i);
      if (LITERAL_WORDS.has(text)) push('lit', start, LITERAL_WORDS.get(text), nl);
      else push(KEYWORDS_JS.has(text) ? 'kw' : 'ident', start, text, nl);
      continue;
    }

    // ---- 数字。`n` 后缀是 BigInt：值用 BigInt 存，别的用 Number ----
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let radix = 10;
      if (c === '0' && /[xXoObB]/.test(src[i + 1] ?? '')) {
        radix = RADIX.get(src[i + 1].toLowerCase());
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(src[i])) i++;
      } else {
        while (i < n && /[0-9_]/.test(src[i])) i++;
        if (src[i] === '.') { i++; while (i < n && /[0-9_]/.test(src[i])) i++; }
        if (src[i] === 'e' || src[i] === 'E') {
          const save = i;
          i++;
          if (src[i] === '+' || src[i] === '-') i++;
          if (/[0-9]/.test(src[i] ?? '')) while (i < n && /[0-9]/.test(src[i])) i++;
          else i = save;
        }
      }
      const isBig = src[i] === 'n';
      if (isBig) i++;
      const raw = src.slice(start, i);
      const digits = raw.replace(/n$/, '').replace(/_/g, '');
      let value;
      if (isBig) value = BigInt(digits);
      else if (radix === 10) value = Number(digits);
      else value = parseInt(digits.slice(2), radix);
      if (typeof value === 'number' && Number.isNaN(value)) err(start, i, `invalid numeric literal: ${raw}`);
      push(isBig ? 'bigint' : 'num', start, value, nl, { raw });
      continue;
    }

    // ---- 字符串 ----
    if (c === '"' || c === "'") {
      i++;
      let value = '';
      while (i < n && src[i] !== c) {
        if (src[i] === '\n') { err(start, i, 'unterminated string literal'); break; }
        if (src[i] === '\\') { value += escape(); continue; }
        value += src[i++];
      }
      if (src[i] === c) i++;
      else err(start, i, 'unterminated string literal');
      push('str', start, value, nl, { quote: c });
      continue;
    }

    // ---- 模板字符串 ----
    if (c === '`') {
      i++;
      const t = scanTemplate(start, '`');
      if (t.kind === 'tmpl_head') tmpl.push(braces);
      push(t.kind, start, t.cooked, nl, { raw: t.raw });
      continue;
    }

    // ---- `}`：可能是块的结束，也可能是"从内插表达式回到模板文本" ----
    if (c === '}') {
      if (tmpl.length && tmpl[tmpl.length - 1] === braces) {
        tmpl.pop();
        i++;
        const t = scanTemplate(start, '}');
        if (t.kind === 'tmpl_middle') tmpl.push(braces);
        push(t.kind, start, t.cooked, nl, { raw: t.raw });
        continue;
      }
      braces--;
      i++;
      push('punct', start, '}', nl);
      continue;
    }
    if (c === '{') {
      braces++;
      i++;
      push('punct', start, '{', nl);
      continue;
    }

    // ---- 正则字面量 vs 除号 ----
    if (c === '/' && regexAllowed(tokens[tokens.length - 1])) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\n') break;
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        i++;
      }
      if (src[i] !== '/') { err(start, i, 'unterminated regular expression literal'); }
      else i++;
      const bodyEnd = i - 1;
      while (i < n && /[dgimsuvy]/.test(src[i])) i++;
      push('regex', start, src.slice(start + 1, bodyEnd), nl, { flags: src.slice(bodyEnd + 1, i) });
      continue;
    }

    // ---- 运算符 / 标点 ----
    const p = PUNCT_JS.find((op) => src.startsWith(op, i));
    if (p) {
      i += p.length;
      push('punct', start, p, nl);
      continue;
    }

    i++;
    err(start, i, `unexpected character: ${JSON.stringify(c)}`);
  }

  // hashbang 不是 token（它不参与任何语法规则），但生成回去时必须原样留着，所以单独还回去。
  // 刻意**不**挂在 tokens 数组上：这个值域里的 list 带不了属性（ADR-0011 决策 1），
  // 而这个文件自己也要被降级 —— 挂上去在 node 上能跑、降级之后就炸。
  return { tokens, hashbang };
}
