// src/core/plugin.js —— 目标（后端）的注册表（ADR-0021 的 S3）
//
// 分语言那条路上每个后端最终是一个动态库、用到了才 `dlopen`。而 `dlopen` 的前提是
// **调用点不许直接叫函数名**：直接调用就是静态依赖，链接期就把它拽进来了，
// "可选"就无从谈起。所以这一格先立起来 —— 现在每一项都是内建的，行为一个字节都不变
// （四门当场可验），加载器那一半（node 腿动态 `import()`、C 腿 `dlopen` + ABI 版本检查）
// 接在 `target()` 的"没装"那一支上。
//
// 为什么后端先走、前端后走：后端的形状是齐的（吃一份 IR、交一段文本），而六个前端的签名
// 各不相同（`lowerAsy` 吃 tree + diags + opts、`lowerCoreSexpr` 吃 SourceFile……），
// 那一层要先把签名对齐，是另一刀。

import { emitJs } from './backend-js/emit.js';
import { emitC } from './backend-c/emit.js';
import { emitLlvm } from './backend-llvm/emit.js';
import { emitSpirv } from './backend-spirv/emit.js';
import { OmniError } from './source/diag.js';

/** 每一项：`ir` 说它吃哪一层（oir / mir），`emit(ir, opts)` 交一段文本。 */
const TARGETS = {
  js: { ir: 'oir', emit: (m, o) => emitJs(m, o) },
  c: { ir: 'oir', emit: (m, o) => emitC(m, o === undefined ? {} : o) },
  llvm: { ir: 'mir', emit: (m) => emitLlvm(m) },
  spirv: { ir: 'mir', emit: (m, o) => emitSpirv(m, o === undefined ? undefined : o.kernel) },
};

/**
 * 按名字取一个目标。
 *
 * "没装"要**响着拒**，不能是一句 `undefined is not a function` —— 以后这一支就是
 * `dlopen` 的入口：先找 `omni-target-<名字>.dylib`，找不到才报这一句，
 * 而且要报"没装"而不是"不认识"（两件事，用户的下一步动作不同）。
 */
export function target(name) {
  const t = TARGETS[name];
  if (t === undefined) {
    throw new OmniError(`目标 '${name}' 没装：内建的是 ${Object.keys(TARGETS).join(' / ')}`);
  }
  return t;
}

/** 装着的目标都有哪些（`--help` 与诊断用同一份，不许各写一遍） */
export function targetNames() {
  return Object.keys(TARGETS);
}

/* ---- 语言（前端）：按扩展名认，谁装了谁**自己登记** ----
 *
 * 与目标那半张表的差别：前端的实现住在 cli.js 里（它们要用 cli 的一整套读盘 / 诊断 /
 * 缓存），所以这一层不 import 它们（会成环），改成"加载完自己来登记"。
 * 这正好是插件要的形状：`dlopen` 出来的那一格在 `omni_plugin_init` 里调 registerLang，
 * 与内建项走同一条路 —— 内建与外挂在这一层看不出区别，只是登记的时刻不同。
 */
const LANGS = new Map();

/** @param exts 扩展名（带点）@param name 语言名 @param compile (path, argv) -> { mod, ... } */
export function registerLang(exts, name, compile) {
  for (const e of exts) LANGS.set(e, { name, compile });
}

/** 这个路径归哪种语言；不归任何登记过的语言就交 null（调用方落到核心方言那一支） */
export function lang(path) {
  for (const [ext, l] of LANGS) {
    if (path.endsWith(ext)) return l;
  }
  return null;
}

/** 装着的语言都有哪些 */
export function langNames() {
  const out = [];
  for (const [, l] of LANGS) if (!out.includes(l.name)) out.push(l.name);
  return out;
}
