// src/core/lang/builtin-core.js —— **编出来的核心**内建哪些（ADR-0021 的 S4）
//
// 一个都不内建。omni 的核心是**驱动 + 注册表 + 插件加载器**：语言前端、目标后端，
// 连 js -> c 那条都是插件（`plugins/omni-lang-js.dylib`、`omni-target-c.dylib`）。
// 没有插件的 omni 什么语言都不认、什么目标都不出 —— 它只会印用法、然后响着拒
// （见 plugin.js 的 lang/target/cap 三处拒法：都点名缺的是哪一格插件）。
//
// 为什么是"另一份文件"而不是一个 if：静态 import 没法按条件取消 —— 要真不把 js 前端
// 编进来，就不能有那一句 `import ... from './js.js'`。编译器读 `lang/builtin.js` 时
// 拿到的是**这一份**（接缝在 linkJs 的 read 回调上，见 cli.js 的 readModule）。
//
// 那么 `builtin.js` 那份"全都要"给谁用？给 **JS 宿主腿**（开发/自举那条）：node 没有
// 同步的 ESM import，装不动插件（host/native.js 的 pluginsOk），所以它只能全内建 ——
// 而它正是那条**把插件编出来**的腿。一句话：**从源码跑的那条腿全都有，编出来的核心
// 一格都没有，功能全在 plugins/ 里。**

/** 与 builtin.js 同名同形状 —— 换的是内容，不是接口。这一份刻意什么都不登记。 */
export function registerBuiltins(api) {
}
