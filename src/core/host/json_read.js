// Omni stage0 — JSON 的**读**那一半
//
// 为什么手写：`JSON.parse` 不在封闭 ABI 里（ADR-0011 决策 2 —— C 那一侧的
// omni_js_json.h 只有 stringify）。asy 的 AST 磁盘缓存（cli.js 的 parseText）要把树读
// 回来，原先直接用 JSON.parse，于是自举那条腿当场红：
//   src/core/cli.js:175:17: 'JSON.parse' is not in the closed ABI
// 编译器自己能读的东西不能超出它自己能编的子集 —— 所以读那一半写在这里。
//
// 只认 `JSON.stringify` 会吐出来的那一份（对象 / 数组 / 字符串 / 数 / true / false / null）：
// 写的那一侧就在同一个仓库里，不必收更宽的输入。语义要与 JSON.parse 一致，
// 不一致的地方就是缓存读回来的树与新解析的树不同 —— 那是最难查的一类错。
import { OmniError } from '../source/diag.js';

const ESC = new Map([
  [34, '"'], [92, '\\'], [47, '/'],
  [98, '\b'], [102, '\f'], [110, '\n'], [114, '\r'], [116, '\t'],
]);

/** 一次解析的游标（下标存在对象里：这一族函数互相递归，要共享它） */
class Cur {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }

  bad(why) {
    return new OmniError(`json: ${why}（第 ${this.i} 个字符处）`);
  }

  ws() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      this.i++;
    }
  }

  /** 期望一个定字符（`,` `:` `}` `]` 那些），顺带吃掉它前后的空白 */
  eat(ch) {
    this.ws();
    if (this.s[this.i] !== ch) throw this.bad(`要 '${ch}'，这里是 '${this.s[this.i] ?? '<末尾>'}'`);
    this.i++;
  }

  str() {
    const s = this.s;
    if (s[this.i] !== '"') throw this.bad('要一个字符串');
    this.i++;
    // 常路：整段没有反斜杠时**一次切片**（AST 里绝大多数字符串是标识符与源码片段）
    let j = this.i;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 34) { const out = s.slice(this.i, j); this.i = j + 1; return out; }
      if (c === 92) break;
      j++;
    }
    let out = s.slice(this.i, j);
    this.i = j;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 34) { this.i++; return out; }
      if (c !== 92) { out += s[this.i]; this.i++; continue; }
      const e = s.charCodeAt(this.i + 1);
      const one = ESC.get(e);
      if (one !== undefined) { out += one; this.i += 2; continue; }
      if (e !== 117) throw this.bad('不认识的转义');
      const hex = s.slice(this.i + 2, this.i + 6);
      if (hex.length !== 4) throw this.bad('\\u 后面要四位十六进制');
      out += String.fromCharCode(Number(`0x${hex}`));
      this.i += 6;
    }
    throw this.bad('字符串没有收尾的引号');
  }

  value() {
    this.ws();
    const s = this.s;
    const ch = s[this.i];
    if (ch === undefined) throw this.bad('没有值');
    if (ch === '"') return this.str();
    if (ch === '{') {
      this.i++;
      const o = {};
      this.ws();
      if (s[this.i] === '}') { this.i++; return o; }
      for (;;) {
        this.ws();
        const k = this.str();
        this.eat(':');
        o[k] = this.value();
        this.ws();
        if (s[this.i] === ',') { this.i++; continue; }
        this.eat('}');
        return o;
      }
    }
    if (ch === '[') {
      this.i++;
      const a = [];
      this.ws();
      if (s[this.i] === ']') { this.i++; return a; }
      for (;;) {
        a.push(this.value());
        this.ws();
        if (s[this.i] === ',') { this.i++; continue; }
        this.eat(']');
        return a;
      }
    }
    if (s.startsWith('true', this.i)) { this.i += 4; return true; }
    if (s.startsWith('false', this.i)) { this.i += 5; return false; }
    if (s.startsWith('null', this.i)) { this.i += 4; return null; }
    // 数：JSON 的数就是 `-? int frac? exp?`，把这一段切出来交给 Number
    let j = this.i;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      const ok = (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46 || c === 101 || c === 69;
      if (!ok) break;
      j++;
    }
    if (j === this.i) throw this.bad(`不认识的值 '${ch}'`);
    const num = Number(s.slice(this.i, j));
    if (Number.isNaN(num)) throw this.bad(`不是一个数：'${s.slice(this.i, j)}'`);
    this.i = j;
    return num;
  }
}

/** 读一份 JSON 文本（只收我们自己 stringify 出来的那一份，见文件头） */
export function parseJson(text) {
  const c = new Cur(text);
  const v = c.value();
  c.ws();
  if (c.i !== text.length) throw c.bad('末尾还有多余的东西');
  return v;
}
