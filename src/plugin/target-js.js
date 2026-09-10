// src/plugin/target-js.js —— JS 后端的插件入口（ADR-0021 的 S4）
//
// 独立编译成 plugins/omni-target-js.dylib。自举链那两条不动点（omni.mjs）出自它。

import { registerJsTarget } from '../core/target/js.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniTargetJs(api) {
  registerJsTarget(api);
  return true;
}
