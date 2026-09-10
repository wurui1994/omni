// src/plugin/lang-js.js —— JS 前端的插件入口（ADR-0021 的 S4）
//
// 独立编译成 plugins/omni-lang-js.dylib。核心里一格语言都没有，`.js` 也得靠这一格。

import { registerJsLang } from '../core/lang/js.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()：registerLang / registerCap / log。 */
export function omniLangJs(api) {
  registerJsLang(api);
  return true;
}
