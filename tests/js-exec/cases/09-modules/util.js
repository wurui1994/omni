// 被导入的模块：常量、函数、类、以及"再往下一层"的导入
import { CHARS, repeatStr } from './text.js';

export const VERSION = "1.2";

export function twice(x) {
  return x * 2;
}

export function banner(name) {
  return `${repeatStr(CHARS, 2)}${name}${repeatStr(CHARS, 2)}`;
}

export class Counter {
  constructor(start) {
    this.n = start;
  }
  bump() {
    this.n = this.n + 1;
    return this.n;
  }
}

// 模块级的语句也要跑，而且要跑在依赖之后、导入方之前
export const table = new Map();
table.set("a", 1);
table.set("b", 2);

/* 改名的导出（`export { x as y }`）：整棵 import 树拼成一个程序、名字共用一个顶层空间，
   所以改名摊成一句模块级绑定 `const y = x;`（与 import 改名那一支同一招）。 */
const localTag = "tag";
function localAdd(a, b) { return a + b; }
export { localTag as TAG, localAdd as add };
