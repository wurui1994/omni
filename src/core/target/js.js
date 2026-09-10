// src/core/target/js.js —— JS 后端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/ 那几门同一条规矩：**不 import cli.js**、自己登记。注册表那一层看不出内建与外挂 ——
// 做成动态库之后由 `omni_plugin_init` 调同一个 register。
// 名字带前缀是自举链的硬约束（模块作用域的名字整份程序里唯一）。

import { emitJs, emitJsFunc, emitJsRuntimeModule } from '../backend-js/emit.js';

/** 登记：`ir` 说它吃哪一层（oir / mir），`emit(ir, opts)` 交一段文本。 */
export function registerJsTarget(api) {
  api.registerTarget('js', 'oir', (m, o) => emitJs(m, o));
  /* 驱动那边另外两格（同样不许它直接 import 后端）：`jsgen.func` 一个函数一段文本
     （增量编译按函数走），`jsgen.runtimeModule` 出那份 `omni_rt.js`。 */
  api.registerCap('jsgen.func', (m, f) => emitJsFunc(m, f));
  api.registerCap('jsgen.runtimeModule', () => emitJsRuntimeModule());
}
