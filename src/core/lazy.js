// src/core/lazy.js —— 核心自己那几摊**用到才装**（node 源码腿那一份）
//
// 装的是"按动词才要"的那些部件：链接器（`omni c link` / `build`）、两个汇编器（原生那条腿）、
// 构建引擎（`omni ninja`）、REPL、MIR 解释器、`eval` 的钩子…… 跑一份 `.py` 的 js 腿一格都
// 用不到，而从前它们全是 `cli.js` 的静态 import。机制在 `lazy-core.js`，这一份只给"怎么装"。
//
// **同步装**靠 `createRequire`（node 22.12 起 `require()` 能装没有顶层 await 的 ESM）——
// 与 `lower/borrow.js` 同一条路子，理由也一样：`runCli` 整条链是同步的，而我们自己的 JS
// 前端明着拒动态 `import()`（`the module graph is fixed at link time`）。
//
// 这一份只给**从源码跑的那条腿**（它 import `node:module`）。编产物时由 `cli.js` 的
// `readModule` 换成 `lazy-fat.js`（一张静态 import 的表，产物里一格不少）——
// 规则在 `lazy-pick.js`。

import { createRequire } from 'node:module';
import { modOr } from './lazy-core.js';

const require_ = createRequire(import.meta.url);

/**
 * 相对 `src/core/` 的路径 -> 那份模块（`coreMod('link/macho.js').writeObject(…)`）。
 * 不必自己记住：`require` 本身就有模块缓存。
 *
 * 路径是**相对这一份文件**算的（`createRequire(import.meta.url)` 的 base 就是它），
 * 不走 `treeRoot()`：那一格靠"往上找 package.json / .git"认布局，而 js-roundtrip 那条轴
 * 会把整棵树重新生成到 `.omni-build/js-roundtrip/` 下 —— 那儿没有标志文件，`treeRoot()`
 * 退回"往上数三格"就指到了别处，症状是 `[host crash]`（量到的）。相对自己永远对。
 */
export function coreMod(p) {
  return modOr(require_(`./${p}`), p);
}
