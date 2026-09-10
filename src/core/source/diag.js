// Omni stage0 — 源文件、位置与诊断
// stage0 是一次性脚手架：目标是把 stage1（用 Omni 写的编译器）编译出来，不追求性能。

export class SourceFile {
  /** @param {string} path @param {string} text */
  constructor(path, text) {
    this.path = path;
    this.text = text;
    /** @type {number[]} 每行起始 offset */
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  /** offset -> {line, col}，均从 1 起 */
  lineCol(offset) {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      // 用除法而不是 >> 1：位运算在这个值域里只对 int 成立，而下标都是 real（决策 1）
      const mid = Math.floor((lo + hi + 1) / 2);
      if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo] + 1 };
  }

  lineText(line) {
    const start = this.lineStarts[line - 1];
    const end = line < this.lineStarts.length ? this.lineStarts[line] : this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$/, '');
  }
}

/** @typedef {{file: SourceFile, start: number, end: number}} Span */

/** @param {SourceFile} file @param {number} start @param {number} end @returns {Span} */
export function span(file, start, end) {
  return { file, start, end };
}

export class OmniError extends Error {}

export class Diagnostics {
  constructor() {
    /** @type {{severity: string, span: Span|null, msg: string}[]} */
    this.items = [];
  }

  error(span, msg) {
    this.items.push({ severity: 'error', span, msg });
    return this;
  }

  warn(span, msg) {
    this.items.push({ severity: 'warning', span, msg });
    return this;
  }

  // 方法而不是 getter：getter 不在 JS 子集里（ADR-0011 决策 13），自举要过这一关
  errorCount() {
    return this.items.filter((d) => d.severity === 'error').length;
  }

  hasErrors() {
    return this.errorCount() > 0;
  }

  /**
   * 试探性求值的存档/回滚：检查器与解析器都要"先试一遍，不满意就把诊断丢掉"。
   * 回滚用 pop 而不是 `items.length = n` —— 给 list 写 .length 不在值域里（ADR-0011）。
   */
  mark() {
    return this.items.length;
  }

  rollback(mark) {
    while (this.items.length > mark) this.items.pop();
  }

  /** 渲染成 clang 风格的多行诊断（带 caret） */
  format() {
    const out = [];
    for (const d of this.items) {
      if (!d.span) {
        out.push(`omni: ${d.severity}: ${d.msg}`);
        continue;
      }
      const { file, start, end } = d.span;
      const { line, col } = file.lineCol(start);
      out.push(`${file.path}:${line}:${col}: ${d.severity}: ${d.msg}`);
      const src = file.lineText(line);
      out.push(`  ${src}`);
      const width = Math.max(1, Math.min(end - start, src.length - col + 1));
      out.push(`  ${' '.repeat(col - 1)}${'^'.repeat(width)}`);
    }
    return out.join('\n');
  }

  /** 有错误则抛出，错误文本即格式化后的诊断 */
  throwIfErrors() {
    if (this.hasErrors()) throw new OmniError(this.format());
  }

  /**
   * **警告要真的印出来**（ADR-0022 的 J4d）。从前它们只是攒在 `items` 里，一个字都不出去
   * —— 于是「类型推不出来时给一条 warning」这条承诺是空的：`import … as g` 猜签名、
   * `with "h"` 里跳过的那些声明，用的人一句都看不到。
   *
   * 回的是要印的文本（空串 = 没有警告）。**印在 stderr 上**：stdout 是程序自己的输出，
   * 每条腿都在按字节比它。
   */
  warnings() {
    const out = [];
    for (const d of this.items) {
      if (d.severity !== 'warning') continue;
      if (!d.span) { out.push(`omni: warning: ${d.msg}`); continue; }
      const { file, start } = d.span;
      const { line, col } = file.lineCol(start);
      out.push(`${file.path}:${line}:${col}: warning: ${d.msg}`);
    }
    return out.length === 0 ? '' : `${out.join('\n')}\n`;
  }
}
