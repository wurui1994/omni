// src/core/lazy-core.js —— "一份模块用到才装"的**机制**（纯函数，两条腿共用）
//
// 与 `lower/borrow-core.js` 是同一条道理的两格：那一份管**借来的那几门语言**
// （回"运行时那半"那个小对象），这一份管**核心自己那几摊**（回整份模块）。
// 差别只在"怎么把模块拿到手"（`load`）：
//   `lazy.js`      node 源码腿 —— `createRequire`（同步装 ESM）
//   `lazy-fat.js`  编产物那条腿 —— 一张静态 import 的表（产物里不能有 `require`）
// 接缝规则在 `lazy-pick.js`（它同时管 `lower/borrow.js` 那一格）。
//
// **刻意不是 `mkCoreMod(load)` 那种"造一格闭包"的工厂**：两条腿各写一个普通 `coreMod`，
// 形状一模一样、少一层间接（同一条理由见 `lower/borrow-core.js` 的文件头）。
//
// 为什么要它（量到的账见 `docs/design/on-demand-loading.md` 第五节第 2 刀）：`cli.js` 的
// 六十条静态 import 合计 **716.9ms**，而跑一份 `.py` 的 js 腿用不到的有四百来毫秒 ——
// 链接器九份（61ms）、两个汇编器（45ms）、`host/src_eval.js`（69ms，它静态 import 了整套
// JS 前端）、构建引擎（26ms）、REPL（19ms）、MIR 解释器（15ms）…… 而这些的**调用点只有
// 一两处**：`omni build` 才要链接器，`omni repl` 才要 REPL。

import { OmniError } from './source/diag.js';

/**
 * 装进来的那份模块 + 它的路径 -> 那份模块（装不进来就当场抛）。
 *
 * 路径就是键，写成 `'link/macho.js'` 这种 —— 与 `lazy-fat.js` 那张表的键**逐字相同**。
 * 两种坏法要分得清：源码腿是"这个路径不对"，产物腿是"`lazy-fat.js` 的表里漏了一格"。
 * 都要响 —— 悄悄回 `undefined` 会变成十几层之下的 `x is not a function`。
 */
export function modOr(m, p) {
  if (m === null || m === undefined) {
    throw new OmniError(`核心那一格装不进来：${p}`
      + '（源码腿：路径不对；产物腿：lazy-fat.js 那张表里漏了这一格）');
  }
  return m;
}
