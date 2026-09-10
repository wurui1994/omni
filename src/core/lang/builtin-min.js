// src/core/lang/builtin-min.js —— **最小核心**内建哪些（ADR-0021 的 S4）
//
// 只有 js -> c 这条路（外加 js 后端 —— 自举链的两条不动点是 emit-js 出来的 omni.mjs）。
// 别的语言与目标不在这份产物里，靠 `plugins/` 里的 `omni-lang-*.dylib` / `omni-target-*.dylib`
// 装进来（核心启动时扫那个目录，见 cli.js 的 discoverPlugins）。
//
// 为什么是"另一份文件"而不是一个 if：静态 import 没法按条件取消 —— 要真不把 asy 编进来，
// 就不能有那一句 `import ... from './asy.js'`。`--builtins min` 让编译器读 `builtin.js` 时
// 拿到的是**这一份**（接缝在 linkJs 的 read 回调上，见 cli.js 的 readModule）。
//
// 两份都短、都摆在一起：漂了一眼就看出来。

import { registerJsLang } from './js.js';
import { registerJsTarget } from '../target/js.js';
import { registerCTarget } from '../target/c.js';

/** 与 builtin.js 同名同形状 —— 换的是内容，不是接口。 */
export function registerBuiltins(api) {
  registerJsTarget(api);
  registerCTarget(api);
  registerJsLang(api);
}
