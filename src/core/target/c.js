// src/core/target/c.js —— C 后端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/ 那几门同一条规矩：**不 import cli.js**、自己登记。注册表那一层看不出内建与外挂 ——
// 做成动态库之后由 `omni_plugin_init` 调同一个 register。
// 名字带前缀是自举链的硬约束（模块作用域的名字整份程序里唯一）。

import { emitC, emitCWithStats, emitCUnits } from '../backend-c/emit.js';

/** 登记：`ir` 说它吃哪一层（oir / mir），`emit(ir, opts)` 交一段文本。 */
export function registerCTarget(api) {
  api.registerTarget('c', 'oir', (m, o) => emitC(m, o === undefined ? {} : o));
  /* 驱动那边还要两格比"交一段文本"多的东西（都不许让它直接 import 后端）：
     `cgen.stats` 交 { text, stats, syms } —— 按源文件的产出分布，与这一份发了哪些符号
     （`.syms`，插件 `--bind` 要它）；`cgen.units` 交分文件发射的那几段。
     叫 cgen 而不是 c：`c.*` 那一串是 **C 这门语言**（lang/c.js）的，两回事。 */
  api.registerCap('cgen.stats', (m, o) => emitCWithStats(m, o === undefined ? {} : o));
  api.registerCap('cgen.units', (m, o) => emitCUnits(m, o === undefined ? {} : o));
}
