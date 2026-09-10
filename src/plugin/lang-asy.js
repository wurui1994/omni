// src/plugin/lang-asy.js —— asy 这门语言的插件入口（ADR-0021 的 S4）
//
// 这一份**独立编译**成 plugins/omni-lang-asy.dylib：自己发 asy 那一族的函数体
// （`--own`），别的（运行时、容器、字面量池、核心那几千个函数）全绑到核心上 ——
// 所以它是几 MB 而不是十几 MB，而核心里也就不必带 asy。
//
// 核心 dlopen 它之后调 `omni_plugin_init`，那一句里调的就是下面这一格。

import { registerAsyLang } from '../core/lang/asy.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()：registerLang / registerCap / log。 */
export function omniLangAsy(api) {
  registerAsyLang(api);
  return true;
}
