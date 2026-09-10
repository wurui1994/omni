// src/plugin/lang-c.js —— C 这门语言（预处理 / C -> MIR / c obj）的插件入口（ADR-0021 的 S4）

import { registerCLang } from '../core/lang/c.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniLangC(api) {
  registerCLang(api);
  return true;
}
