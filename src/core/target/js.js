// src/core/target/js.js —— JS 后端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/ 那几门同一条规矩：**不 import cli.js**、自己登记。注册表那一层看不出内建与外挂 ——
// 做成动态库之后由 `omni_plugin_init` 调同一个 register。
// 名字带前缀是自举链的硬约束（模块作用域的名字整份程序里唯一）。

import { emitJs } from '../backend-js/emit.js';

/** 登记：`ir` 说它吃哪一层（oir / mir），`emit(ir, opts)` 交一段文本。 */
export function registerJsTarget(api) {
  api.registerTarget('js', 'oir', (m, o) => emitJs(m, o));
}
