#!/usr/bin/env node
/**
 * `omni serve` 的 **node 侧入口**（`src/core/serve.js` 的壳子）。
 *
 * 为什么另开一份文件、而不是让 `cli.js` 直接 import 那一份：
 *
 *   * `core/serve.js` 里有 `node:http` / `Buffer` / `async` / `import.meta` 那一族东西，
 *     而 `check:self`（`emit js/c src/cli.js`）会把**静态 import 到的每一份**都编一遍 ——
 *     把一个 HTTP 服务编进原生腿没有任何收益；
 *   * 动态 `import()` 也不行：我们自己那台 JS 前端还不认它（量出来是
 *     `expected ';' after statement, found 'then'`）。**这不是"绕过子集"** ——
 *     serve 本来就是一个**独立的常驻程序**，让它有自己的入口是它该有的形状。
 *
 * 于是 `cli.js` 那一格只做一件事：`spawn(node, [这份文件, …])`，直通 stdio。
 * Ctrl-C 直接到这个进程，`cli.js` 那边跟着回来。
 */

import { cmdServe } from './core/serve.js';

cmdServe(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`omni serve: ${e.message ?? e}\n`);
  process.exit(1);
});
