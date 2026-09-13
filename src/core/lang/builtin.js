// src/core/lang/builtin.js —— 内建的那几门语言/目标怎么**迟装**（ADR-0023 的 S7）
//
// 从前这一份是 12 条静态 `import`（8 门语言 + 4 个目标），于是"跑任何一条腿"都等于
// "把整个编译器装进来"。量出来的账（ADR-0023）：
//   - 每条测试轴的**依赖并集都是同一份 112 个模块**，里头含着每一门语言的前端。改
//     `frontend-jnc/lower.js` 会让 wat / cabi / js-exec 这些语义上毫无关系的轴指纹全变、
//     全部重跑 —— 一趟 8 分钟，而其中绝大多数轴的输出一个字节都没动。
//   - 一次 CLI 调用里，装全套 `lang/builtin.js` 0.12s，只装一门 0.05s（node 自己 0.04s）。
//     一条 jnc 轴 570 次子进程，光这一格就是半分钟。
//
// 所以这一份改成**声明**：一门语言只交三样 —— 它认哪些后缀 / 它能答哪几格 cap / 怎么把
// 自己装进来。注册表（plugin.js）在真被问到的时候才叫那个 loader。声明与实际登记**核对**
// 一遍（plugin.js 的 resolvePending：装完发现它没登记声称的那一格就当场响错），所以
// "两处各写一遍后缀"不会悄悄走散。
//
// 同步装是靠 `createRequire`：node 22.12 起 `require()` 能装没有顶层 await 的 ESM，
// 而我们所有模块都没有顶层 await。这一步刻意**不用** `import()` —— 那是异步的，会把
// "查一门语言"这件事染成 async，而它埋在编译路径深处。
//
// 这一份只给**从源码跑的那条腿**（node）。编出来的产物走 `builtin-fat.js`（全静态 import）
// 或 `builtin-core.js`（一格都不装、全靠 plugins/*.dylib）—— 换哪一份是 cli.js 的
// readModule 决定的：我们自己的 JS 前端不认 `require`/`import()`，所以这一份不能被它编。

import { createRequire } from 'node:module';
import { declareExts } from '../ext.js';
import { join } from '../host/path.js';

const require_ = createRequire(import.meta.url);

/**
 * 内建那几格的**声明表**。一行一格：
 *   - `mod` / `reg`：真要装的时候 `require(mod)[reg](api)`；
 *   - `exts`：这门语言认的后缀（`lang()` 按它挑）；
 *   - `runnerExts`：这门语言自己带"怎么跑"（glsl 渲一帧，ADR-0019 决策九）；
 *   - `targets`：这个目标叫什么名字（`target()` 按它挑）；
 *   - `caps`：它登记的那几格本事（`cap()` 按它挑）。
 *
 * 名字（`name`）是 `--help` 与诊断里印的那一个，**不装也要说得出来** —— 所以它在表里。
 */
export const BUILTINS = [
  { name: 'js', mod: './js.js', reg: 'registerJsLang', exts: ['.js'] },
  { name: 'wat', mod: './wat.js', reg: 'registerWatLang', exts: ['.wat'] },
  {
    name: 'sx',
    mod: './sx.js',
    reg: 'registerSxLang',
    exts: ['.sx'],
    caps: ['sx.textToMod', 'sx.repl'],
  },
  {
    name: 'asy',
    mod: './asy.js',
    reg: 'registerAsyLang',
    exts: ['.asy'],
    caps: ['asy.toSx', 'asy.deps', 'asy.unitName', 'asy.jsUnitSym', 'asy.fileUnitName',
      'asy.mainWord', 'asy.unitTexts', 'asy.astUnpack', 'asy.frontEnd', 'asy.repl'],
  },
  {
    name: 'jnc', mod: './jnc.js', reg: 'registerJncLang', exts: ['.jnc'], caps: ['jnc.toSx'],
  },
  {
    name: 'glsl', mod: './glsl.js', reg: 'registerGlslLang', runnerExts: ['.frag', '.glsl'],
  },
  {
    name: 'c',
    mod: './c.js',
    reg: 'registerCLang',
    caps: ['c.toMir', 'c.sysInclude', 'c.usrLib', 'c.preprocess', 'c.toMirNative', 'c.declsOf'],
  },
  {
    name: 'grammar', mod: './grammar.js', reg: 'registerGrammarLang', caps: ['glr.table', 'glr.run'],
  },
  {
    name: 'js',
    mod: '../target/js.js',
    reg: 'registerJsTarget',
    targets: ['js'],
    caps: ['jsgen.func', 'jsgen.runtimeModule'],
  },
  {
    name: 'c',
    mod: '../target/c.js',
    reg: 'registerCTarget',
    targets: ['c'],
    caps: ['cgen.stats', 'cgen.units'],
  },
  { name: 'llvm', mod: '../target/llvm.js', reg: 'registerLlvmTarget', targets: ['llvm'] },
  { name: 'spirv', mod: '../target/spirv.js', reg: 'registerSpirvTarget', targets: ['spirv'] },
];

/** 把内建的那些**声明**进注册表。`api` 就是给插件的那一格（形状一模一样，只差登记的时刻）。 */
export function registerBuiltins(api) {
  for (const b of BUILTINS) {
    api.declareProvider({
      name: b.name,
      exts: b.exts,
      runnerExts: b.runnerExts,
      targets: b.targets,
      caps: b.caps,
      from: b.mod,
    }, () => require_(b.mod)[b.reg](api));
  }
  /* 再扫一遍**扩展**（ADR-0030 第 4 节）：别人写的语言不进上面那张表 —— 它们各自一个目录、
     各自一份 `omni-ext.json` 自述，核心只按约定找、按约定装。装法在这儿注入（这条腿用
     `require`），所以"怎么装"不是 `ext.js` 的知识；`ext.js` 只管"约定与声明"。

     内建先声明、扩展后声明：同一个后缀两边都认时，**内建赢**（先声明先命中）。这条要写下来，
     因为它决定了别人能不能悄悄顶掉我们的语言 —— 不能。 */
  declareExts((dir, entry) => require_(join(dir, entry)), api);
}
