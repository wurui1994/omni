// src/core/lazy-fat.js —— **一次全装**的那一份（编产物时用）
//
// 与它并列的那一份：`lazy.js`（迟装，`createRequire`，只给从源码跑的 node 腿）。
// 我们自己的 JS 前端不认 `node:module` 也不认 `import()`，所以迟装那一份编不过去 ——
// 编译时由 `cli.js` 的 `readModule` 换成这一份（规则在 `lazy-pick.js`，与
// `lang/builtin-pick.js` / `lower/borrow-pick.js` 同一个接缝）。
//
// **产物里一格不少**：这一份把所有能迟装的核心部件都静态 import 进来，所以"改成按需装载"
// 不会让 `dist/omni` 少一样本事。省下来的是**源码腿**每条命令的启动。
//
// 加一格迟装的模块要改两处（这一份 + 调用点），漏了这一处的症状很清楚：产物腿上
// 「核心那一格装不进来：xxx（…lazy-fat.js 那张表里漏了这一格）」—— `lazy-core.js` 明着抛。

import { modOr } from './lazy-core.js';
import { installSrcEvalHook } from './host/src_eval.js';
import { genArm64Module } from './arm64/from_mir.js';
import { genModule } from './x64/from_mir.js';
import { ninjaCmd } from './build/cli.js';
import { startRepl } from './repl.js';
import { bootstrapSelf } from './bootstrap.js';
import { interpret } from './interp/eval.js';
import { interpretMir, runMirModule } from './mir/interp.js';
import { emitMirJs } from './mir/emit_js.js';
import { runMirJs } from './mir/js_rt.js';
import { dumpBytes } from './mir/bytes.js';

/**
 * 相对 `src/core/` 的路径 -> 那份模块的导出。键与调用点写的那个字符串**逐字相同**
 * （也与 `lazy.js` 那条 `require` 拼出来的路径一致）。
 */
const MODS = new Map([
  ['host/src_eval.js', { installSrcEvalHook }],
  ['arm64/from_mir.js', { genArm64Module }],
  ['x64/from_mir.js', { genModule }],
  ['build/cli.js', { ninjaCmd }],
  ['repl.js', { startRepl }],
  ['bootstrap.js', { bootstrapSelf }],
  ['interp/eval.js', { interpret }],
  ['mir/interp.js', { interpretMir, runMirModule }],
  ['mir/emit_js.js', { emitMirJs }],
  ['mir/js_rt.js', { runMirJs }],
  ['mir/bytes.js', { dumpBytes }],
]);

/** 相对 `src/core/` 的路径 -> 那份模块。 */
export function coreMod(p) {
  return modOr(MODS.get(p), p);
}
