// Omni stage0 — S 表达式读取器（ADR-0014 决策 1）
//
// S 表达式是前端汇聚点，位置在 OIR 之上：每种语法各有一份 grammar，GLR 解析出 CST，
// 按映射标注落到 S 表达式，然后**只有一份** `S-EXPR -> OIR` 的降级。这个文件是那条链
// 最底下的一块 —— 把括号文本读成树。
//
// 词法照 WebAssembly 文本格式（WAT）的规矩来，不自己发明一套：
//   - 注释两种：`;;` 到行尾，`(; ... ;)` 可嵌套
//   - 标识符/关键字/数字统统是 **atom**，字符集就是 WAT 的 idchar 表（见 IDCHAR）
//   - 字符串只有双引号一种，转义按 WAT：`\t \n \r \" \' \\` 与 `\XX` 两位十六进制
// 挑 WAT 的理由不是它好看，是它**已经被写下来了**：一份公开的词法规格，加上大量现成的
// 测试素材。自己定一套 s-expr 方言只会多一份没人校对过的规格。
//
// 读出来的树刻意只有三种节点，别的一切（"这是个 func"、"这是个 i32.add"）都由上层去认：
//   {kind:'list',   items, span}
//   {kind:'atom',   value, span}          原样的文本，不做数字解析
//   {kind:'string', value, raw, span}     value 是解码后的码点串，raw 是引号内的原文
// 数字不在这里解析：`0x1p3`、`nan:0x4000`、`1_000` 这些的含义取决于目标类型
// （i32 的 `0xffffffff` 合法，i64 的不同），读取器不该猜。

import { span as mkSpan } from '../source/diag.js';

/** WAT 的 idchar 表（规格里那一行的原样抄录）。atom 就是一串 idchar。 */
const IDCHAR = new Set(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&'*+-./:<=>?@\\^_`|~".split(''),
);

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * 读一份源文件，返回顶层节点表。
 *
 * 顶层是**一串**节点而不是一个：WAT 的文件可以是一个 `(module ...)`，也可以是一串
 * 顶层字段（wast 的脚本形式就是），所以这里不替上层决定"只能有一个"。
 *
 * @param {import('../source/diag.js').SourceFile} file
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {{kind:'list'|'atom'|'string', [k:string]: any}[]}
 */
export function readSexpr(file, diags) {
  const src = file.text;
  let i = 0;
  /* `#lang <名字>` 与 shebang：**只在第一行**，整行跳过（ADR-0037）。
   * `#` 在上面那张 idchar 表里，所以不跳的话 `#lang` 与它后面那个名字会读成两个顶层 atom，
   * 而上层等的是 `(module …)` 那种表。这一行是给**驱动**看的（`cli.js` 的 `pickLang` 拿它
   * 决定这份文件交给谁读），到这儿它的活已经干完了；开关也在那一层，所以这儿不判开关。 */
  if (src.startsWith('#!')) {
    while (i < src.length && src[i] !== '\n') i++;
    if (i < src.length) i++;
  }
  {
    let j = i;
    while (j < src.length && isSpace(src[j])) j++;
    if (src.startsWith('#lang', j)) {
      i = j;
      while (i < src.length && src[i] !== '\n') i++;
    }
  }

  const err = (start, end, msg) => diags.error(mkSpan(file, start, end), msg);

  /** 跳过空白与注释。块注释可嵌套，所以要数深度。 */
  const skip = () => {
    for (;;) {
      while (i < src.length && isSpace(src[i])) i++;
      if (src[i] === ';' && src[i + 1] === ';') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (src[i] === '(' && src[i + 1] === ';') {
        const start = i;
        let depth = 0;
        while (i < src.length) {
          if (src[i] === '(' && src[i + 1] === ';') { depth++; i += 2; continue; }
          if (src[i] === ';' && src[i + 1] === ')') { depth--; i += 2; if (depth === 0) break; continue; }
          i++;
        }
        if (depth !== 0) err(start, src.length, 'unterminated block comment');
        continue;
      }
      return;
    }
  };

  /**
   * 字符串。转义表照 WAT，`\XX` 是**两位**十六进制的字节值 —— 注意它是字节而不是码点：
   * WAT 的字符串本质是字节串（data 段用得上）。这里按码点存，值 >= 0x80 的字节按
   * Latin-1 的口径直接当码点，不去猜它是某个 UTF-8 序列的一半 —— 真要拼 UTF-8 的
   * 是上层（data 段），到时候它拿 raw 自己拼。
   */
  const readString = () => {
    const start = i;
    i++;  // 开引号
    let out = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] !== '\\') { out += src[i++]; continue; }
      const e = src[i + 1];
      i += 2;
      if (e === 't') { out += '\t'; continue; }
      if (e === 'n') { out += '\n'; continue; }
      if (e === 'r') { out += '\r'; continue; }
      if (e === '"' || e === "'" || e === '\\') { out += e; continue; }
      if (e === 'u' && src[i] === '{') {
        const close = src.indexOf('}', i);
        if (close < 0) { err(start, src.length, 'unterminated \\u{...} escape'); break; }
        const cp = Number.parseInt(src.slice(i + 1, close), 16);
        if (!Number.isInteger(cp) || cp > 0x10ffff) err(start, close + 1, `bad code point in \\u{...}`);
        else out += String.fromCodePoint(cp);
        i = close + 1;
        continue;
      }
      const hex = src.slice(i - 1, i + 1);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(Number.parseInt(hex, 16)); i += 1; continue; }
      err(i - 2, i, `unknown escape '\\${e ?? ''}'`);
    }
    if (src[i] !== '"') {
      err(start, src.length, 'unterminated string');
      return { kind: 'string', value: out, raw: src.slice(start + 1), span: mkSpan(file, start, src.length) };
    }
    i++;  // 闭引号
    return { kind: 'string', value: out, raw: src.slice(start + 1, i - 1), span: mkSpan(file, start, i) };
  };

  /** 一个节点。返回 null 表示"到头了"或"遇到多余的右括号"（后者已经报过错）。 */
  const node = () => {
    skip();
    if (i >= src.length) return null;
    const c = src[i];
    if (c === '(') {
      const start = i;
      i++;
      const items = [];
      for (;;) {
        skip();
        if (i >= src.length) {
          err(start, src.length, 'unterminated list: missing )');
          break;
        }
        if (src[i] === ')') { i++; break; }
        const n = node();
        if (n === null) break;
        items.push(n);
      }
      return { kind: 'list', items, span: mkSpan(file, start, i) };
    }
    if (c === ')') {
      err(i, i + 1, 'unexpected )');
      i++;
      return null;
    }
    if (c === '"') return readString();
    const start = i;
    while (i < src.length && IDCHAR.has(src[i])) i++;
    if (i === start) {
      err(i, i + 1, `unexpected character ${JSON.stringify(c)}`);
      i++;
      return null;
    }
    return { kind: 'atom', value: src.slice(start, i), span: mkSpan(file, start, i) };
  };

  const out = [];
  for (;;) {
    const n = node();
    if (n === null) {
      skip();
      if (i >= src.length) break;
      continue;  // 报过错了，往下接着读，一次跑出尽量多的诊断
    }
    out.push(n);
  }
  return out;
}

/** 便利判断，上层认结构时到处要用 */
export const isList = (n) => n !== undefined && n !== null && n.kind === 'list';
export const isAtom = (n) => n !== undefined && n !== null && n.kind === 'atom';
export const isStr = (n) => n !== undefined && n !== null && n.kind === 'string';

/** `(head ...)` 的 head 文本；不是那个形状就返回 null */
export function head(n) {
  if (!isList(n) || n.items.length === 0) return null;
  return isAtom(n.items[0]) ? n.items[0].value : null;
}
