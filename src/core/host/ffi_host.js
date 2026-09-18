/**
 * FFI 注入那条路的**宿主一侧**（ADR-0038 第二刀）。
 *
 * 与 `src_eval.js` 同一个形状、同一个理由：`process.dlopen` 与"往宿主全局上摆一格东西"
 * 都是**这一代宿主**的事实，不该散在 cli.js 里 —— 原生那一代（自举出来的编译器）没有
 * node、也没有 addon，那时这两格就是一句清楚的错误。
 *
 * 三件事：
 *   - `dlopenAddon(path)`   装一份 N-API 扩展，回它的 exports（`omni_ffi_host.node` 就是它）
 *   - `publishCffi(obj)`    把注好的那格 `$cffi` 摆到宿主全局上；发出来那份 JS 从这儿取
 *   - `hasAddonLoader()`    这一代宿主装不装得动扩展
 *
 * 为什么走 `evalJs` 而不是直接写 `process.dlopen`：`process` 不在这份编译器自己的
 * JS 子集里（`check:self` 那道门），而 `evalJs` 是**已经在的**那扇门（ADR-0013）。
 * 摆全局那一格照 `src_eval.js` 的先例，用的是同一个机制。
 */

import { evalJs } from './native.js';

/** 发出来那份 JS 里 `$cffi` 找的那个名字。**改这儿要同时改 `backend-js/cffi.js` 的 glue。** */
export const CFFI_GLOBAL = '$OMNI_CFFI';

export function hasAddonLoader() {
  try {
    return evalJs('typeof process !== "undefined" && typeof process.dlopen === "function"') === true;
  } catch {
    return false;
  }
}

/**
 * 装一份 N-API 扩展。
 *
 * `process.dlopen(m, path)` 要一个 `{exports}` 形状的对象与一个**绝对**路径（相对路径
 * 会按 cwd 解，而子进程的 cwd 不一定是仓库根 —— 那种失败是静默的）。
 */
export function dlopenAddon(path) {
  return evalJs(`(() => { const m = { exports: {} };`
    + ` process.dlopen(m, ${JSON.stringify(path)}); return m.exports; })()`);
}

/** 把注好的那格交给宿主全局（发出来那份 JS 的 glue 从这儿取）。 */
export function publishCffi(obj) {
  globalThis[CFFI_GLOBAL] = obj;
}
