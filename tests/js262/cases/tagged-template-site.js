// 带标签模板的**站点身份**（规范 13.2.8.4 的模板缓存）：同一处模板站点每次求值都该
// 拿到同一格 strings 数组，不同站点之间彼此不同。拿它当 Map / WeakMap 键的库靠的正是
// 这个 —— 每次新造一格的话缓存永远打不中，而且 `site() === site()` 会静静地为假。
function tag(s) { return s; }
function site() { return tag`a${1}b`; }
console.log(site() === site());
const a = site();
console.log(a[0], a[1], a.raw[0], a.length, a.raw.length);
// 两处**写法一样**的站点仍是两格：身份跟着源码位置，不跟着内容。
function other() { return tag`a${1}b`; }
console.log(site() === other());
const seen = new Map();
function memo() { const s = tag`x${0}y`; if (!seen.has(s)) seen.set(s, seen.size); return seen.get(s); }
console.log(memo(), memo(), memo(), seen.size);
// 循环里的站点也只有一格（不是每转一圈新造一格）。
const ids = new Map();
for (let i = 0; i < 3; i++) { const s = tag`loop${i}`; if (!ids.has(s)) ids.set(s, i); }
console.log(ids.size);
// cooked 是转义之后的，raw 是原文那一份；缓存的是同一格，两份都在。
function esc() { return tag`\n${1}\t`; }
const e = esc();
console.log(JSON.stringify(e[0]), JSON.stringify(e.raw[0]), JSON.stringify(e[1]), JSON.stringify(e.raw[1]));
console.log(esc() === esc(), esc() === site());
// 递归下来的同一处站点还是同一格（槽是模块级的，不跟调用栈走）。
function nested(n) { return n === 0 ? tag`deep` : nested(n - 1); }
console.log(nested(0) === nested(3));
