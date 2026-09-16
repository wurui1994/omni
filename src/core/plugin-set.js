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

/**
 * **核心自己**要的数据（不属于哪一格插件）：运行时的 C 源码、JIT 宿主、GL 后端。
 * 生成的 C 只写一句 `#include "omni.h"`，剩下靠 `-I runtime` 与把 `runtime/*.c` 一起
 * 喂给 cc —— 所以那几份源码得跟着产物走，否则装好的 omni 编不出可执行文件
 * （量出来：`ENOENT: cannot read directory '<repo>/runtime'`）。
 *
 * `probe` 是认这个目录的标志文件：光按名字找会撞上同名的**代码**目录 ——
 * `runtime` 在源码树里有两个（`src/runtime` 是 C，`src/core/runtime` 是 JS），
 * 抄错的那次把 `c_runtime.js` 抄进了 dist/share/runtime，然后 clang 说找不到 omni.h。
 */
export const CORE_DATA = [
  { dir: 'runtime', probe: 'omni.h' },
  { dir: 'jit', probe: 'omni_jit.c' },
  { dir: 'runtime-gl', probe: 'omni_gl.h' },
  /* C 前端**自带的那几份头**（`stdbool.h`/`stddef.h`/`stdarg.h`/`float.h` —— tcc 的
     `{B}/include` 那一格）。不带走的话装好的编译器一编 C 就说 `stdbool.h` 找不着，
     而 `omni.h` 头几行就 include 它：`OMNI_CC=self` 的第二代于是过不去（第一百三十八片）。 */
  { dir: 'include', probe: 'stdbool.h' },
  /* `std` 那个包（`import "std/json.omni"`）。它属于核心而不是哪一格插件 ——
     `print(<dynamic>)` 就要它，而那句话跟装了哪几门语言无关。子目录（lib/asy）不在这里：
     那是 asy 插件的数据，跟着那一格走。 */
  { dir: 'lib', probe: 'json.omni' },
];
