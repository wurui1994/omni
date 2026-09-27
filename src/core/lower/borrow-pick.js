// src/core/lower/borrow-pick.js —— 编**我们自己的源码**时，`lower/borrow.js` 换成哪一份
//
// 与 `lang/builtin-pick.js` 同构、同一条道理：
//   `borrow.js`      迟装 —— `createRequire`，只给从源码跑的那条腿（node）。我们自己的
//                    JS 前端不认 `node:module`，也不认 `import()`。
//   `borrow-fat.js`  十三条静态 import —— 编产物时用它，产物里 adapter 一格不少。
//
// 为什么单独一份：**换哪一份不是某一处的事**。`cli.js` 的 `readModule` 要它，
// 哪天别的地方也要把这棵树降一遍（`tests/mir` 那条轴就把 cli.js 自己降到 MIR）时同样要它 ——
// 少一处就会拿迟装那一份去编，报的是"前端不认这句"，而真相是"读错了文件"。
//
// 这一份**不像 builtin 那样分 fat / core 两档**：借来的语言现在还不是插件
// （`PLUGIN_SET` 里没有它们），所以"核心那一档"如果换成空的，`dist/omni run x.py` 会从
// "能跑"变成"报没装"。那是 ADR-0030 的终局，是另一笔账（要给 `PLUGIN_SET` 加十一格），
// 不混在按需装载这一刀里。

/**
 * @param p 正在读的那份源码路径
 * @returns 该换成的路径；不是 `lower/borrow.js` 就回 null
 */
export function borrowAlt(p) {
  if (!p.endsWith('/lower/borrow.js')) return null;
  return `${p.slice(0, p.length - 'borrow.js'.length)}borrow-fat.js`;
}
