// src/plugin/target-spirv.js —— SPIR-V 后端的插件入口（ADR-0021 的 S4）

import { registerSpirvTarget } from '../core/target/spirv.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniTargetSpirv(api) {
  registerSpirvTarget(api);
  return true;
}
