// src/core/lazy-pick.js —— 编**我们自己的源码**时，那两份迟装的文件各换成哪一份
//
// 两格迟装、同一个接缝（与 `lang/builtin-pick.js` 同构）：
//   `lower/borrow.js`  借来的那十三格语言 adapter  -> `lower/borrow-fat.js`
//   `lazy.js`          核心自己那几摊按动词的部件  -> `lazy-fat.js`
// 两份迟装的都 import `node:module`（`createRequire`），而我们自己的 JS 前端不认它
// （`'node:module' is not importable; use the closed ABI`），也不认 `import()`
// （`the module graph is fixed at link time`）。
//
// 为什么规则单独一份：**换哪一份不是某一处的事**。`cli.js` 的 `readModule` 要它，
// 哪天别处也要把这棵树降一遍（`tests/mir` 那条轴就把 cli.js 自己降到 MIR）时同样要它 ——
// 少一处就会拿迟装那一份去编，报的是"前端不认这句"，而真相是"读错了文件"。
//
// **不像 builtin 那样分 fat / core 两档**：这两格换成空的会让产物少本事
// （`dist/omni run x.py` 报"没装"、`omni build` 找不到链接器）。那是 ADR-0030 的终局
// （各自一格插件），是另一笔账。

/**
 * @param p 正在读的那份源码路径
 * @returns 该换成的路径；两格都不是就回 null
 */
export function lazyAlt(p) {
  if (p.endsWith('/lower/borrow.js')) {
    return `${p.slice(0, p.length - 'borrow.js'.length)}borrow-fat.js`;
  }
  if (p.endsWith('/core/lazy.js')) {
    return `${p.slice(0, p.length - 'lazy.js'.length)}lazy-fat.js`;
  }
  return null;
}
