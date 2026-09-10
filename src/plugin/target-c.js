// src/plugin/target-c.js —— C 后端的插件入口（ADR-0021 的 S4）
//
// 独立编译成 plugins/omni-target-c.dylib。产品那条路（js -> c）的后半段就是它；
// 驱动要的 cgen.stats / cgen.units 两格也在这一份里登记。

import { registerCTarget } from '../core/target/c.js';

/** 插件的注册入口。`api` 就是核心的 pluginApi()。 */
export function omniTargetC(api) {
  registerCTarget(api);
  return true;
}
