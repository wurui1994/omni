// src/core/build/lexer.js —— manifest 的词法（照 `reference/ninja/src/lexer.in.cc`）
//
// ninja 那份是 re2c 生成的；这儿手写同一套规则。**要一字不差的地方只有三处**，
// 别的都是表面形状：
//
//   1. `$` 的转义：`$$` = 一个 `$`、`$ ` = 一个空格（路径里）、`$:` = 一个冒号、
//      `$<换行>` = 续行（连同后面那一串缩进一起吃掉）、`$name` / `${name}` = 变量。
//   2. **缩进有意义**：行首的空白是 INDENT，它把绑定挂到上一条 rule / build 上。
//      所以这一层不能"顺手 trim"。
//   3. 值与路径的**停止条件不同**：值读到行尾（空格是值的一部分），路径读到
//      空格 / `:` / `|` / 行尾。同一个 `$ ` 在两处意思都是"字面空格"，
//      但只有路径那侧非它不可。
//
// 词法错误要带位置与那一行的原文（`errorAt`）—— 构建文件多数是生成的，
// 报错不指行等于让人去猜生成器。

export const T = {
  EOF: 'eof',
  BUILD: 'build',
  COLON: ':',
  DEFAULT: 'default',
  EQUALS: '=',
  IDENT: 'ident',
  INCLUDE: 'include',
  INDENT: 'indent',
  NEWLINE: 'newline',
  PIPE: '|',
  PIPE2: '||',
  PIPEAT: '|@',
  POOL: 'pool',
  RULE: 'rule',
  SUBNINJA: 'subninja',
};

const KEYWORDS = new Map([
  ['build', T.BUILD], ['default', T.DEFAULT], ['include', T.INCLUDE],
  ['pool', T.POOL], ['rule', T.RULE], ['subninja', T.SUBNINJA],
]);

/** 标识符能用的字符（照 ninja：路径也走这一套，所以 `/`、`.`、`-` 都在里头）。 */
const isIdentChar = (c) => /[a-zA-Z0-9_./\-+\\]/.test(c);

export class Lexer {
  constructor(text, filename) {
    this.text = text;
    this.filename = filename ?? '<manifest>';
    this.pos = 0;
    /** 上一个记号的起点（报错指位置用） */
    this.tokenStart = 0;
  }

  atEnd() { return this.pos >= this.text.length; }
  peek() { return this.text[this.pos] ?? '\0'; }

  /** 报错：`文件:行:列: 那句话`，再把那一行与一个指针印出来。 */
  errorAt(msg, at) {
    const p = at ?? this.tokenStart;
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < p; i++) {
      if (this.text[i] === '\n') { line++; lineStart = i + 1; }
    }
    let lineEnd = this.text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = this.text.length;
    const col = p - lineStart + 1;
    const src = this.text.slice(lineStart, lineEnd);
    return new Error(`${this.filename}:${line}:${col}: ${msg}\n    ${src}\n    ${' '.repeat(col - 1)}^`);
  }

  /** 吃掉注释与续行之后的一格记号。 */
  next() {
    for (;;) {
      this.tokenStart = this.pos;
      if (this.atEnd()) return { t: T.EOF };
      const c = this.peek();
      /* 行首的缩进（只在行首有意义；别处的空格在下面被跳掉） */
      if ((c === ' ' || c === '\t') && this.atLineStart()) {
        while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
        /* 全是空白的一行不算 INDENT —— 它什么也没挂上 */
        if (this.peek() === '\n' || this.peek() === '#' || this.atEnd()) continue;
        return { t: T.INDENT };
      }
      if (c === ' ' || c === '\t') { this.pos++; continue; }
      if (c === '\r') { this.pos++; continue; }
      if (c === '\n') { this.pos++; return { t: T.NEWLINE }; }
      if (c === '#') {
        while (!this.atEnd() && this.peek() !== '\n') this.pos++;
        continue;
      }
      /* `$` 在记号层只可能是续行（别的 `$` 都在值/路径里处理） */
      if (c === '$' && this.text[this.pos + 1] === '\n') { this.pos += 2; continue; }
      if (c === '=') { this.pos++; return { t: T.EQUALS }; }
      if (c === ':') { this.pos++; return { t: T.COLON }; }
      if (c === '|') {
        if (this.text[this.pos + 1] === '|') { this.pos += 2; return { t: T.PIPE2 }; }
        if (this.text[this.pos + 1] === '@') { this.pos += 2; return { t: T.PIPEAT }; }
        this.pos++;
        return { t: T.PIPE };
      }
      if (isIdentChar(c)) {
        const s = this.pos;
        while (!this.atEnd() && isIdentChar(this.peek())) this.pos++;
        const word = this.text.slice(s, this.pos);
        const kw = KEYWORDS.get(word);
        /* 关键字也带上原文：`pool = heavy` 里那个 `pool` 是**名字**，不是关键字
           （ninja 那边靠"这个位置只 ReadIdent"分开，我们靠调用方要不要名字分开）。 */
        return kw === undefined ? { t: T.IDENT, value: word } : { t: kw, value: word };
      }
      throw this.errorAt(`不认识的字符 '${c}'`);
    }
  }

  atLineStart() {
    return this.pos === 0 || this.text[this.pos - 1] === '\n';
  }

  /**
   * 读一格**值**（`=` 右边那一串）：读到行尾，空格是值的一部分。
   * 回一份片段序列（`['lit', s]` / `['var', name]`），交给 `EvalString`。
   */
  readVarValue() { return this.readEvalString(false); }

  /**
   * 读一格**路径**（`build` 行上那些）：读到空格 / `:` / `|` / 行尾。
   * 空的话回 `null`（调用方按"没有更多路径了"处理）。
   */
  readPath() {
    const parts = this.readEvalString(true);
    return parts.length === 0 ? null : parts;
  }

  /**
   * 两者共用的那台机器。`path === true` 时空格与 `:` `|` 结束这一格。
   *
   * `$` 后面能跟的东西**穷举在这儿**，多一样少一样都是与 ninja 的分叉：
   *   `$$` 一个美元   `$ ` 一个空格   `$:` 一个冒号   `$<换行>` 续行（吃掉后续缩进）
   *   `${name}` / `$name` 变量引用
   */
  readEvalString(path) {
    /** @type {Array<[string,string]>} */
    const parts = [];
    let lit = '';
    const flush = () => { if (lit !== '') { parts.push(['lit', lit]); lit = ''; } };
    /* 前导空格不算内容（`= ` 与 `build a: cc  b` 里那些） */
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
    for (;;) {
      if (this.atEnd()) break;
      const c = this.peek();
      if (c === '\n' || c === '\r') break;
      if (c === '#' && path) break;
      if (path && (c === ' ' || c === ':' || c === '|')) break;
      if (c === '$') {
        const d = this.text[this.pos + 1] ?? '\0';
        if (d === '\n') {
          this.pos += 2;
          /* 续行：把下一行的缩进一起吃掉。值那一侧要补一个空格（ninja 的规矩：
             续行是"接着写"，不是"粘在一起"）—— 路径那一侧本来就以空白分隔。 */
          while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
          continue;
        }
        if (d === '$' || d === ' ' || d === ':') { lit += d; this.pos += 2; continue; }
        if (d === '{') {
          const end = this.text.indexOf('}', this.pos + 2);
          if (end === -1) throw this.errorAt('`${` 没有收口', this.pos);
          flush();
          parts.push(['var', this.text.slice(this.pos + 2, end)]);
          this.pos = end + 1;
          continue;
        }
        if (isIdentChar(d)) {
          let p = this.pos + 1;
          while (p < this.text.length && isIdentChar(this.text[p])) p++;
          flush();
          parts.push(['var', this.text.slice(this.pos + 1, p)]);
          this.pos = p;
          continue;
        }
        throw this.errorAt(`'$' 后面跟了不认识的 '${d}'`, this.pos);
      }
      lit += c;
      this.pos++;
    }
    flush();
    return parts;
  }
}
