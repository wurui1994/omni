// src/core/plugin-set.js —— **默认构建**出哪几格插件（ADR-0021 的 S4）
//
// 核心什么都不内建，所以"omni 能干什么"等于"plugins/ 里有哪几格"。这一份就是那个清单：
// 一行一格，`name` 同时决定三件事 ——
//   入口文件   src/plugin/<name>.js
//   注册函数   omni + <name> 的驼峰（lang-asy -> omniLangAsy）
//   产物名     plugins/omni-<name>.dylib
//
// `own` 是"这一格自己发哪些文件里的函数与全局"（别的绑到核心上，见 emit.js 的 emitsSym）。
// 为什么不能全自动推：几门语言共用 sexpr / glr，而它们**不许互相依赖**（插件之间没有
// 依赖关系这回事），所以共用的那几份各自带一套 —— 哪几份共用只有这张表说得清。
//
// `data` 是这一格要的**数据**（语法表、内建绑定表、库源码）。它们不是代码，编译器不会
// 编进 dylib，所以 `omni plugins` 按这张表抄进 `dist/share/`；跑的时候由 host/data.js
// 按布局找回来。目录写成末尾带 `/` 的那种（`lib/asy/`）—— 整个目录抄过去。

export const PLUGIN_SET = [
  { name: 'lang-js', own: ['core/lang/js.js', 'frontend-js/'], data: [] },
  { name: 'lang-wat', own: ['core/lang/wat.js', 'frontend-wat/'], data: [] },
  { name: 'lang-sx', own: ['core/lang/sx.js', 'sexpr/'], data: [] },
  {
    name: 'lang-asy',
    own: ['core/lang/asy.js', 'frontend-asy/', 'sexpr/', 'glr/'],
    data: ['frontend-asy/asy.grammar', 'frontend-asy/builtins.tab', 'lib/asy/'],
  },
  {
    name: 'lang-jnc',
    own: ['core/lang/jnc.js', 'frontend-jnc/', 'sexpr/', 'glr/'],
    data: ['frontend-jnc/jnc.grammar'],
  },
  { name: 'lang-glsl', own: ['core/lang/glsl.js', 'frontend-glsl/'], data: [] },
  { name: 'lang-c', own: ['core/lang/c.js', 'frontend-c/'], data: [] },
  { name: 'lang-grammar', own: ['core/lang/grammar.js', 'glr/', 'sexpr/print.js'], data: [] },
  { name: 'target-js', own: ['core/target/js.js', 'backend-js/'], data: [] },
  { name: 'target-c', own: ['core/target/c.js', 'backend-c/'], data: [] },
  { name: 'target-llvm', own: ['core/target/llvm.js', 'backend-llvm/'], data: [] },
  { name: 'target-spirv', own: ['core/target/spirv.js', 'backend-spirv/'], data: [] },
];

/** `lang-asy` -> `omniLangAsy`。产物名与入口文件都由 name 直接拼出来，不再单列。 */
export function pluginRegName(name) {
  let out = 'omni';
  for (const part of name.split('-')) out += part.charAt(0).toUpperCase() + part.slice(1);
  return out;
}
