// src/core/lang/builtin-fat.js —— **一次全装**的那一份（ADR-0021 S4 / ADR-0023 S7）
//
// 这一份把 8 门语言 4 个目标全部**静态 import** 进来。谁用它：
//   - **编出来的产物**（`build --fat` / `emit-js` 那条）。我们自己的 JS 前端不认
//     `import()`（"dynamic import('...') is not supported (the module graph is fixed at
//     link time)"）也不认顶层 `await`，所以迟装那一份编不过去 —— 编译时由 cli.js 的
//     readModule 把 `lang/builtin.js` 换成这一份（与换 `builtin-core.js` 同一个接缝）。
//   - 诊断"是不是迟装弄错了"时拿它比对。
//
// 从源码跑的那条腿走 `builtin.js`（**迟装**）：一门语言只在真被问到时才装进来。
// 理由是量出来的（ADR-0023 S7）：不迟装的话每条测试轴的依赖并集都是同一份 112 个模块 ——
// 改一门语言的前端，wat / cabi / js-exec 这些毫无关系的轴指纹也全变、全部重跑。
//
// 这一份不 import cli.js —— 与它下面那几门同一条规矩。


import { registerJsLang } from './js.js';
import { registerWatLang } from './wat.js';
import { registerSxLang } from './sx.js';
import { registerAsyLang } from './asy.js';
import { registerJncLang } from './jnc.js';
import { registerGlslLang } from './glsl.js';
import { registerCLang } from './c.js';
import { registerGrammarLang } from './grammar.js';
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
  registerCLang(api);
  registerGrammarLang(api);
}
