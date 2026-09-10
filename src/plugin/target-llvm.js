// src/plugin/target-llvm.js —— LLVM IR 后端的插件入口（ADR-0021 的 S4）

import { registerLlvmTarget } from '../core/target/llvm.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniTargetLlvm(api) {
  registerLlvmTarget(api);
  return true;
}
