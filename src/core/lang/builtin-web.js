// src/core/lang/builtin-web.js —— **浏览器那条腿的内建表**（单体 HTML 用这一份）
//
// 与它并列的两份（同一个接缝，见 `builtin-fat.js` 的文件头）：
//   `builtin.js`      迟装 —— 靠 `createRequire`（`node:module`），只给 node 那条腿
//   `builtin-fat.js`  一次全装 —— 八门语言四个目标全是静态 import（编出来的产物）
//   **这一份**         `builtin-fat` 再加上 `ext/` 里那几格**用 JS 写的扩展**
//
// 为什么要第三份：`ext/lua` / `ext/gsl-shell` / `ext/tiny` 是**扩展**（ADR-0030 的 SDK 面），
// 核心不认识它们 —— 它们由 `omni-ext.json` 自述、被问到时才装，而"怎么装"是宿主注入的：
// node 那条腿 `require`，编出来的腿 dlopen 一份 `.dylib`。**浏览器两样都没有**：
// 页面里既没有 `require` 也没有 `dlopen`，而打包器只认静态 import。
//
// 所以这一份把那三格的入口静态 import 进来，再用同一条 `declareExts` 声明出去 ——
// 注册表那一层看不出谁是内建、谁是扩展（这正是 ext.js 那份契约要的），而"装"变成了
// "在一张表里查一下"。少了这一份，页面上 `omni run x.lua` 报的是
// "不认识 basics.lua 这种扩展名"，而那门语言的代码明明就在这份 HTML 里。
//
// 这一份**不进 `--fat` 产物**：那一档的插件是真插件（`plugins/omni-lang-*.dylib`），
// 不该为了浏览器把三格扩展焊进去。接缝在 `tools/bundle-studio.mjs` 的 `SWAP`。

import { registerBuiltins as registerFatBuiltins } from './builtin-fat.js';
import { declareExts } from '../ext.js';
import { registerLuaExt } from '../../../ext/lua/omni-lang.js';
import { registerGslExt } from '../../../ext/gsl-shell/omni-lang.js';
import { registerTinyExt } from '../../../ext/tiny/omni-lang.js';

/**
 * `<扩展目录的名字>/<入口>` -> 那份模块。
 *
 * 键只取**最后两段**：`extDirs()` 找到的根在这条腿上是 `ext`，可它也可能是别的形状
 * （`OMNI_EXT_PATH`、安装位置旁边的那棵）—— 按后缀认就不挑路径长什么样。
 */
const STATIC_EXTS = new Map([
  ['lua/omni-lang.js', { registerLuaExt }],
  ['gsl-shell/omni-lang.js', { registerGslExt }],
  ['tiny/omni-lang.js', { registerTinyExt }],
]);

/** 把内建的那些 + `ext/` 那三格登记进注册表。 */
export function registerBuiltins(api) {
  registerFatBuiltins(api);
  declareExts((dir, entry) => {
    const segs = `${dir}/${entry}`.split('/');
    const key = segs.slice(Math.max(0, segs.length - 2)).join('/');
    const mod = STATIC_EXTS.get(key);
    if (mod === undefined) {
      /* 拒得响：这条腿上"装不动"与"没打包进来"是两件事，后者是打包脚本的漏。 */
      throw new Error(`浏览器这条腿上没有这格扩展的代码：${dir}/${entry}`
        + `（打包时要在 lang/builtin-web.js 里静态 import 它；现有的是 ${[...STATIC_EXTS.keys()].join('、')}）`);
    }
    return mod;
  }, api);
}
