// src/core/lower/borrow-fat.js —— **一次全装**的那一份（编产物时用）
//
// 与它并列的两份（同一个接缝，规则在 `borrow-pick.js`）：
//   `borrow.js`       迟装 —— `createRequire`，**只给从源码跑的那条腿**（node）
//   **这一份**         十三条静态 import —— 产物里 adapter 一格不少，与这一刀之前等价
//
// 为什么要它：我们自己的 JS 前端不认 `node:module`（`'node:module' is not importable;
// use the closed ABI`）也不认 `import()`（`the module graph is fixed at link time`），
// 所以迟装那一份编不过去。编译时由 `cli.js` 的 `readModule` 把 `lower/borrow.js` 换成
// 这一份 —— 与把 `lang/builtin.js` 换成 `builtin-fat.js` 是同一个接缝、同一条道理。
//
// **这一份不该越长越大**：ADR-0030 的终局是借来的语言各自一格插件
// （`PLUGIN_SET` 里一行 `lang-python`，产物腿 dlopen），那时这一份就该没了。
// 在那之前它守住一条："改成按需装载"**不许**让产物少一门语言 —— 那是另一笔账。
//
// 浏览器那条腿吃的是同一份（打包器只认静态 import），见 `tools/bundle-studio.mjs` 的 SWAP。

import { mkBorrowRt } from './borrow-core.js';
import { OmniError } from '../source/diag.js';
import { chezToIR } from '../../../ext/chez/adapter/index.js';
import { sbclToIR } from '../../../ext/sbcl/adapter/index.js';
import { goToIR, goImports } from '../../../ext/go/adapter/index.js';
import { vlangToIR, vlangImports } from '../../../ext/vlang/adapter/index.js';
import { awkToIR, AWK_HOOKS } from '../../../ext/awk/adapter.js';
import { fbToIR } from '../../../ext/freebasic/adapter/index.js';
import { mojoToIR } from '../../../ext/mojo/adapter/index.js';
import { pyToIR, PY_HOOKS } from '../../../ext/python/adapter/index.js';
import { nimToIR, nimImports } from '../../../ext/nim/adapter/index.js';
import { cppToIR } from '../../../ext/cpp/adapter/index.js';
import { polydrawToIR, preprocess } from '../../../ext/polydraw/adapter.js';
import { evaldrawToIR } from '../../../ext/evaldraw/adapter.js';
import { rToIR } from '../../../ext/r/adapter.js';
/* `units` / `runFallback` 那两格不在"一门一个 adapter 入口"里（见 `langs.js` 表头），
   各自的文件也整份摆进来 —— 产物里一格不少。 */
import * as polydrawUnits from '../../../ext/polydraw/units.js';
import * as librRun from '../../../ext/r/libr-run.js';

/**
 * adapter 的路径 -> 那份模块的导出（键与 `langs.js` 里 `adapter` 那一栏**逐字相同**）。
 *
 * 键写全路径而不是语言名：`borrow-core.js` 那格机制只认"装这个模块"，它不认识语言名字
 * （polydraw 与 evaldraw 共用一份语法，却是两份 adapter —— 按路径分才分得开）。
 * 对不上的那一格会被 `mkBorrowRt` 抓住（「装不进 …」/「没有 '…' 这个导出」）。
 */
const MODS = new Map([
  ['ext/chez/adapter/index.js', { chezToIR }],
  ['ext/sbcl/adapter/index.js', { sbclToIR }],
  ['ext/go/adapter/index.js', { goToIR, goImports }],
  ['ext/vlang/adapter/index.js', { vlangToIR, vlangImports }],
  ['ext/awk/adapter.js', { awkToIR, AWK_HOOKS }],
  ['ext/freebasic/adapter/index.js', { fbToIR }],
  ['ext/mojo/adapter/index.js', { mojoToIR }],
  ['ext/python/adapter/index.js', { pyToIR, PY_HOOKS }],
  ['ext/nim/adapter/index.js', { nimToIR, nimImports }],
  ['ext/cpp/adapter/index.js', { cppToIR }],
  ['ext/polydraw/adapter.js', { polydrawToIR, preprocess }],
  /* evaldraw 的 `pre` 与 polydraw 是**同一份** `preprocess`（`ext/polydraw/pre.js`）——
     它由两边的 adapter 各自转手导出，这儿按登记处那一行的名字摆进去。 */
  ['ext/evaldraw/adapter.js', { evaldrawToIR, preprocess }],
  ['ext/r/adapter.js', { rToIR }],
]);

/* `{ adapter, name }` 那两格（`units` / `runFallback`）的模块表 —— 键与登记处逐字相同。 */
const SPEC_MODS = new Map([
  ['ext/polydraw/units.js', polydrawUnits],
  ['ext/r/libr-run.js', librRun],
]);

/**
 * 登记处那一行的 `{ adapter, name }` 一格 -> 那一个导出（`units` / `runFallback`）。
 * 与 `borrowRt` 同一条路子：用的那一刻从表里取，名字对不上当场抛。
 */
export function borrowOne(spec) {
  const mod = SPEC_MODS.get(spec.adapter);
  const v = mod === undefined ? undefined : mod[spec.name];
  if (v === undefined) {
    throw new OmniError(`${spec.adapter} 里没有 '${spec.name}' 这个导出 —— 登记处与代码走散了`);
  }
  return v;
}

/** 登记处那一行 -> 这门语言的运行时那半（`{ toIR, hooks?, imports?, pre? }`）。 */
export const borrowRt = mkBorrowRt((p) => MODS.get(p));
