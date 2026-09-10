// src/plugin/lang-grammar.js —— GLR 那一组（`glr-table` / `glr`）的插件入口（ADR-0021 的 S4）
//
// `.grammar` 不降 OIR，所以这一门只出能力（cap('glr.table') / cap('glr.run')）。

import { registerGrammarLang } from '../core/lang/grammar.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniLangGrammar(api) {
  registerGrammarLang(api);
  return true;
}
