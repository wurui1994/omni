// src/plugin/lang-wat.js —— WebAssembly 文本格式前端的插件入口（ADR-0021 的 S4）

import { registerWatLang } from '../core/lang/wat.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniLangWat(api) {
  registerWatLang(api);
  return true;
}
