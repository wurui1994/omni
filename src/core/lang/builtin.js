// src/core/lang/builtin.js —— 这一份产物里**内建**了哪几门语言、哪几个目标（ADR-0021 的 S4）
//
// 为什么单独一格：核心要变薄，就得能"不 import 某几门语言" —— 而静态 import 没法按条件取消。
// 把那一串收在这一份里，编薄核心时**换掉这一份**就行（linkJs 的 read 回调是现成的接缝：
// 编译器读源码全过它，换一份文本不必动链接器）。
//
// 一条按腿分的事实：node 腿（开发 / 自举宿主）没有 dlopen，所以它只能全内建；
// C 腿（产品）才谈得上"核心只留 js -> c，其余装成 omni-lang-*.dylib"。
//
// 这一份不 import cli.js —— 与它下面那几门同一条规矩。

import { registerJsLang } from './js.js';
import { registerWatLang } from './wat.js';
import { registerSxLang } from './sx.js';
import { registerAsyLang } from './asy.js';
import { registerJncLang } from './jnc.js';
import { registerGlslLang } from './glsl.js';
import { registerJsTarget } from '../target/js.js';
import { registerCTarget } from '../target/c.js';
import { registerLlvmTarget } from '../target/llvm.js';
import { registerSpirvTarget } from '../target/spirv.js';

/** 把内建的那些登记进注册表。`api` 就是给插件的那一格（形状一模一样，只差登记的时刻）。 */
export function registerBuiltins(api) {
  registerJsTarget(api);
  registerCTarget(api);
  registerLlvmTarget(api);
  registerSpirvTarget(api);
  registerJsLang(api);
  registerWatLang(api);
  registerSxLang(api);
  registerAsyLang(api);
  registerJncLang(api);
  registerGlslLang(api);
}
