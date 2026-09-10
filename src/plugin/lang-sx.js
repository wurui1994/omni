// src/plugin/lang-sx.js —— 核心 S 表达式方言（`.sx`）前端的插件入口（ADR-0021 的 S4）

import { registerSxLang } from '../core/lang/sx.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniLangSx(api) {
  registerSxLang(api);
  return true;
}
