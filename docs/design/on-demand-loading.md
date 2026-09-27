# 按需装载：核心不该在启动时把整棵树装进来

跑 `print(1)` 这一行 python，现在要先把**十二门别的语言**、**四个后端的汇编器与链接器**、
**REPL**、**构建引擎**、**wat 前端**、**两台解释器**全部装进内存。这一份说清那笔账是怎么来的、
为什么"加个缓存"不是答案、以及正解落在哪几处现成的机制上。

## 一、量到的账

`node src/cli.js run --mode js -v /tmp/tiny.py`（`/tmp/tiny.py` 就是一行 `print(1)`）：

```
omni: 启动         宿主 + 装编译器  [681ms]
omni: core sexpr front end  …/tiny.sx -> OIR  1 funcs  [119ms]
omni: backend js  157845 bytes  [34ms]
omni: exec in-process (node host, new Function)  [9ms]
omni: 合计  进程内 848ms = 启动 681ms + 步骤 162ms（3 格） + 其余 5ms
```

`--cpu-prof` 那张表把 681ms 拆开（一趟 1363ms 的采样）：

- `compileSourceTextModule` 自用 **283ms（20.8%）** —— V8 逐份解析编译我们这棵树的 `.js`
- 整个 ESM 图装进来（`#getOrCreateModuleJobAfterResolve`）含子 **751ms（55%）**
- `loadGrammarTable` 含子 146ms（`tableFromText` 70 + `readGrammar` 37）
- `spawnSync` 53ms —— `hostArch()` / `hostOs()` 各起一个 `uname`
- GC 72ms、idle 46ms

`src/core/cli.js` 的 **60 条静态 `import`**，逐条量出来（冷进程，各自第一次装）：

```
 225.7ms  ./lower/drive.js      ← 里头 134.7ms 是 ext/ 下十三份 adapter
  68.7ms  ./host/src_eval.js    ← 它静态 import 了整套 frontend-js
  51.2ms  ./mir/from_oir.js      39.8ms  ./host/native.js
  29.7ms  ./arm64/from_mir.js    26.4ms  ./build/cli.js
  26.0ms  ./frontend-wat/lower.js 18.9ms ./repl.js
  14.9ms  ./mir/interp.js        14.7ms  ./x64/from_mir.js
  61.0ms  ./link/*（九份：pe_load/pe_link/elf_exe/elf/macho_exe/elf_merge/macho/flat_image/ldscript）
  …
  60 条静态 import，合计 716.9ms
```

跑一份 `.py` 的 js 腿**真用到**的只有：宿主那几格、`cli/*`（分发）、`glr/*`、
`ext/python/adapter`、`lower/*`、sexpr 前端、`mir/from_oir`、`hir/*`、backend-js。
其余 **400ms 以上**是白付的。

## 二、这不是缓存问题

第一版我按"V8 每趟重新编译同一份源码"去修，开了 `module.enableCompileCache()`。那一格是对的
（同一笔账少付一点），但它**不回答问题**：跑 python 不需要一堆别的语言，`ext/` 那么多；
核心里边的关系也没有按需分配。

缓存把"每趟重新解析编译四百份 `.js`"变成"每趟反序列化四百份字节码"——**装载的份数一格没少**。
按需装载把那四百份变成一百多份。两件事叠加，而后者才是原因。判据上也分得清：缓存改的是
每份的**单价**，按需装改的是**份数**；只看总时间会把两笔混成一笔糊账。

## 三、核心不该认识别人的语言 —— 这条现在是断的

`src/core/lower/langs.js:26-41` 有十三条这样的行：

```js
import { pyToIR, PY_HOOKS } from '../../../ext/python/adapter/index.js';
import { goToIR, goImports } from '../../../ext/go/adapter/index.js';
…
```

ADR-0030 第 4 节说的是反向：**扩展 import 核心，核心一个字都不认识它们**。这条断掉之后不只是慢，
还有两笔看得见的账：

1. **`check:self` 现在就是红的**，红在这条静态链的尽头：
   ```
   ext/python/adapter/pylib.js:18: error: 'node:fs' is not importable; use the closed ABI
   ext/python/adapter/pylib.js:22: error: import cycle through 'ext/python/adapter/expr.js'
   ```
   路径是 `src/core/lower/drive.js:18` → `lower/langs.js:37` → `ext/python/adapter/index.js`
   → `pylib.js`。`lang/builtin.js` 那个 `readModule` 接缝（core / fat 两份）在这条路上**帮不上** ——
   它只换 `lang/builtin.js` 一份文件，而 `langs.js` 是核心自己的静态依赖。
   也就是说：**ext 里某一份文件用了 `node:fs`，自编译轴就红**。这不该是 ext 能做到的事。

2. 加一门语言要改 `src/` 下的登记处，而 `ext/lua`、`ext/tiny`、`ext/gsl-shell` 三门**不用** ——
   它们走 `omni-ext.json` 自述。同一棵树里两套规矩，其中一套违反自己的 ADR。

## 四、机制早就有了，是这几门没进去

不必新造东西。三层现成的机制：

- **`plugin.js` 的声明／迟装**（ADR-0023 S7）：`declareProvider(claim, load)` 只把"我能答哪几问"
  推进 `PENDING`，**不装任何代码**。`cap(name)` / `lang(path)` / `target(name)` 真被问到才
  `resolvePending()` → 调那格 loader → 重查一遍；装完还是没有就当场抛
  「迟装那一格对不上：声明里说有 '…'，装进来之后注册表里却没有它」。所以"声明"与"实现"
  走散会响，不会悄悄错。
- **`ext.js` 的扩展自述**（ADR-0030 第 4 节）：`ext/<name>/omni-ext.json` 交
  `name` / `entry` / `register` / `provides{exts,runnerExts,caps,targets}`，
  `declareExts(load, api)` 按布局扫、声明出去。`ext.js` 里**一个语言名字都没有**。
- **装法由腿注入**：node 源码腿 `createRequire`（**同步** —— node 22.12 起 `require()` 能装
  没有顶层 await 的 ESM，我们所有模块都满足），浏览器腿一张静态表（`builtin-web.js`），
  产物腿 dlopen `plugins/omni-lang-*.dylib`。

"同步"这一条是关键：`sxTextOf` / `coreSxText` / `runCli` 整条链都是同步的，而我们自己的 JS
前端明着拒绝动态 `import()`（`frontend-js/lower.js:2681`：`dynamic import('...') is not
supported (the module graph is fixed at link time)`）。所以正解**不是** `await import()` ——
那会把"查一门语言"染成 async，而它埋在编译路径深处；正解是**注册表 + 同步 require 注入**，
与 ADR-0023 S7 对 `lang/*` 那八门做过的事一模一样。

## 五、设计

### 第 0 刀（先还自己的债）：`ext/python` 违规的那三行

`ext/python/adapter/pylib.js` 直接 `import` 了 `node:fs` / `node:url` / `node:path`，还与
`expr.js` 结了个 import 环。EXTENSIONS.md 第三节明写「宿主 IO 走 `host/native.js`（封闭 ABI），
别直接碰 `node:fs`」—— 这是上一刀我自己写坏的，与按需装载无关，但它压在同一条静态链上，
所以**先修它**：`readText` / `host/path.js` 换掉那三行，环按"谁依赖谁"解开。

判据：`npm run check:self` 从红转绿（这一格现在就是红的）。

### 第 1 刀：借来的十三格 adapter 走注册表迟装

**`lower/langs.js` 拆成两半。**"这门语言叫什么 / 语法在哪 / 认哪些后缀"是**纯数据**，留在核心；
"`toIR` / `hooks` / `imports` / `pre` / `jsRuntime`"是**代码**，挪去 `ext/` 那侧，用到才装。

留下的一行长这样（十三格，一门一行，零 `ext/` import）：

```js
['python', { grammar: 'ext/python/python.grammar', exts: ['py'] }],
```

为什么数据这半可以留在核心：`borrowedExts()` 是 `cli.js` 的**分派依据** —— 它要在装任何东西
**之前**答"这个后缀走不走借来那条路"（`cli.js:5983`），`pickLang` 报错时那张"认得的后缀"清单
也要它。ADR-0030 禁的是核心 import 别人的**代码**，不是核心知道有这么一门语言
（`plugin.js` 的声明表本来就是这个道理：`name` 不装也要说得出来）。

**装进来那一格的形状**：登记处那一行 -> `{ toIR, hooks?, imports?, pre? }`，机制在
`lower/borrow-core.js` 的 `mkBorrowRt(load)`（一门只装一次、记住；导出名取不到当场抛
「登记处与代码走散了」—— 与 `plugin.js` 那格 `pendingMismatch` 同一条纪律）。

**为什么不走 `plugin.js` 的 provider 注册表**：借来的语言**不是 provider** —— 它们不认领后缀
（`cli.js` 判"这是借来的语言"靠 `lang(path) === null && borrowedExts()`，抢过去就改了路）、
也不答 cap。塞进 provider 只会把语义扭一道，而"按名字装一份模块并记住"三十行就写完了。

**`drive.js` 的改法**（`sxTextOf` 里）：

```js
const lang = pickLang(path, cliArg(argv, '--lang'));   // 纯数据，不装代码
const rt = borrowRt(lang);                             // 到这一刻才装这一门
```
底下 `lang.toIR` / `lang.hooks` / `lang.pre` / `lang.imports` 全改成 `rt.*`。
`hasAdapter(lang)` 改成问 `typeof lang.adapter === 'string'`（**只看数据、不装代码**）。

**三条腿各自怎么装**（照 `lang/builtin-pick.js` 那个接缝，一格不新造）：

- **node 源码腿**：`lower/borrow.js` —— `createRequire` 按需装。
- **产物腿**（`emit js` / `emit c` / `dist/omni`）：`lower/borrow-fat.js`（十三条静态 import
  + 一张"adapter 路径 -> 导出"的表），挂在 `cli.js` 的 `readModule` 上（`borrow-pick.js`）。
  **产物里一格不少、行为一格不变**，省下来的是源码腿那 135ms。
  （为什么不直接让产物腿也走插件：那会把 `dist/omni run x.py` 从"能跑"变成"报没装"。
  那是 ADR-0030 的终局，但它是**另一笔账**——要给 `PLUGIN_SET` 加十一格 `lang-*`。）
- **浏览器腿**：`tools/bundle-studio.mjs` 的 `SWAP` 里加一行，也换成 fat 那份
  （页面里既没有 `require` 也没有 `dlopen`，打包器只认静态 import）。

判据（**已达成**）：
- `run --mode js -v /tmp/tiny.py` 的「启动」最小值 **681ms → 257ms**；
  `--cpu-prof` 里栈上出现过的 `ext/` 目录**只有 `python` 一格**（从前十三格全在）。
- `npm run check:self` 两条腿都绿（这一刀之前是红的）。
- `tests/lower` 325 passed / 0 failed、`tests/python` 25 passed / 0 failed / 1 skipped、
  `tests/glr` 41 passed / 1 failed（`table/minidia` 那条是 `654184f6` 留下的快照欠账，
  与这一刀无关 —— 一个 `.grammar` 都没动）。
- `tools/bundle-studio.mjs` 照旧打得出来（279 份模块）。
- `tests/lib/cases.js` 与 `tests/lower/run.js` 里那两句 `typeof d.toIR === 'function'`
  跟着改成问 `d.adapter` —— 不改的话那张"哪几门有 adapter"的表会变空，整套判据静静少跑。

### 第 2 刀：核心自己那几摊也按动词分

`cli.js` 那 60 条静态 import 里，跑一份 `.py` 的 js 腿**一格都用不到**的有这些（按"哪个动词
才需要"分组，括号里是量到的装载耗时）：

- **链接器与可执行文件**（`link/` 九份，61ms）—— 只有 `c link` / `build` / `bootstrap` 要
- **原生后端**（`arm64/from_mir` 30 + `x64/from_mir` 15）—— 只有原生那条腿要
- **`host/src_eval.js`（69ms）** —— 它静态 import 了整套 `frontend-js`（parser + lower），
  而只有"被编的程序里真用了 `eval` / `Function(src)`"才要。这一格的文件头**已经**为后端守住了
  同一条线（「这一格在 host 层，直接 import backend-js 等于把一整套 JS 后端焊进核心」），
  对前端没守住 —— 同一条道理的第二格漏洞
- **wat 前端**（`frontend-wat/lower.js` 26）—— `.wat` 输入才要，而 `lang-wat` **本来就在**
  `BUILTINS` 迟装表里：cli.js 这条直连是第二条路
- **构建引擎**（`build/cli.js` 26 + `build/modules.js` 9 + `modcache.js`）—— `omni ninja` / 模块化那条
- **REPL**（19ms）、**MIR 解释器**（`mir/interp` 15 + `js_rt` 2.7 + `emit_js` 3.3）、
  **`interp/eval.js`**、**`bootstrap.js`**（4.7）
- **`frontend-js/link.js` + `lower.js`** —— `.js` 输入才要，`lang-js` 也已经在迟装表里
- **`frontend-c/split.js`**（`omni c split`）—— 它的 import 上方写着「静态进来而不是
  `await import(…)`：分发那个函数不是 async 的」。那句话的前提是"只有这两条路"；
  **第三条就是本文这条**（注册表 + 同步 require），所以它该跟着挪
- **报表那三份**（`cli/flame.js` / `statgraph.js` / `layers.js`，5ms）

手法与第 1 刀**同一套**（用到才装 + 产物腿走 fat 接缝），机制也共用一格：
`lower/borrow-core.js` 那个 `mkBorrowRt` 的兄弟 —— 一格 `coreMod('link/macho.js')`，
`lazy.js`（node `createRequire`）/ `lazy-fat.js`（静态表）/ `lazy-pick.js`，三份文件、一处接缝，
所有组共用（不是一组三份）。

**先量了调用点才排序**（这决定了这一刀有多便宜）：

- **三条死 import**：`lowerWat` / `lowerJs` / `linkJs` 在 `cli.js` 里**只出现在 import 行**
  （`linkJs` 第 634 行那处是注释）。它们的真正使用者是 `lang/js.js` 与 `lang/wat.js`，
  而那两门本来就在迟装表里 —— 这三条纯属白付 **≈36ms**，直接删。
- **`host/src_eval.js` 69ms，1 个调用点**（`installSrcEvalHook`）—— 性价比最高的一格。
- **`link/` 九份 61ms，一共 13 个调用点**（`writeObject` / `writeElfObject` / `peLoad` /
  `peWrite` / `elfExe` / `machoExe` / `mergeElfObjects` / `parseLdScript` / `isDefSyms` /
  `flatImage`，大多只用 1 次）。
- **`arm64/from_mir` + `x64/from_mir` 45ms，各 1 个调用点**（`genArm64` / `genX64`）。
- **`build/cli.js` 26ms、`repl.js` 19ms、`bootstrap.js` 4.7ms、`interp/eval.js`**——各 1 个。
- **`mir/interp.js` 15ms 3 处、`mir/emit_js.js` 3 处、`mir/js_rt.js` 1 处**。

**刻意不动的几格**（调用点多而装载便宜，改了只是把账搬个地方）：
`runtime/c_runtime.js`（41 处 / 4.2ms）、`build/modules.js` + `modcache.js`（26 处 / 14ms）、
`cli/flame.js`（12 处 / 2ms）、`frontend-c/split.js`（8 处 / 4.7ms）。

预估省 **≥250ms**，而要改的调用点只有二十来处。按上面的顺序**一组一刀**地做。

**判据用"静态 import 图有多大"，不用 wall clock。** 这台机器上 `启动` 那一栏在 257ms 与
900ms 之间跳（IDE 自己就占着十几个核），拿它当判据只会把噪音读成结论。图的大小与负载无关 ——
从入口顺着 `import … from '…'` 递归数份数与字节数（十几行脚本，`link.js` 的 `scan` 干的就是这件事）：

```
第 0/1 刀之前   173 份模块、3859 KB 源码
批 A 之后       106 份模块、1948 KB 源码      -39% 份数 / -49% 字节
```

**批 A 已落**（三条死 import + `src_eval` + 两个汇编器 + `build/cli` + `repl` + `bootstrap`
+ `interp/eval` + `mir/interp|emit_js|js_rt|bytes`）与**批 B 已落**（`link/` 九份）：
`cli.js` 的静态 import 60 条 -> 38 条。机制是 `lazy-core.js`（`modOr(m, p)`）+
`lazy.js`（node `createRequire`）+ `lazy-fat.js`（静态表）+ `lazy-pick.js`（接缝，
**同时管** `lower/borrow.js` 那一格；原来的 `borrow-pick.js` 并进它）。
调用点写成 `coreMod('repl.js').startRepl(…)`。

```
第 0/1 刀之前   173 份模块、3859 KB 源码
批 A 之后       106 份模块、1948 KB 源码
批 B 之后        90 份模块、1586 KB 源码      -48% 份数 / -59% 字节
```

踩到一处**接缝有第二个入口**：`tests/mir/run.js` 自己也有一份 readModule 回调（它把 cli.js
降到 MIR），只过了 `builtinAlt`。`lazy-pick.js` 的文件头预言了这件事，而它当场就发生了 ——
那条轴报 `'node:module' is not importable`。改成 `builtinAlt(p, true) ?? lazyAlt(p) ?? p`。

批 A 的判据（**已达成**）：`tests/mir` 51 passed / 0 failed、`tests/run.js` 105 passed /
0 failed（含 repl 那两条，正好压住 `startRepl` 的迟装）、`tests/js-roundtrip` 675 passed /
0 failed（含"整棵树重新生成再跑全套"那一轴）、`check:self` 两条腿绿。

**批 A 里踩到的两处，都值得单独记**（都是"node 上一切正常、换条腿才炸"的那一类）：

1. **第一版把机制写成了返回闭包的工厂**（`mkBorrowRt(load)` / `mkCoreMod(load)`）。node 源码腿
   全绿、`check:self` 全绿，可 `./dist/omni run x.py` 报 `undefined is not a function`。
   我第一反应断定"返回闭包不在子集里"—— **那个判断是错的**（写最小复现测过：`() => {…}` 返回
   闭包、对象字面量简写、动态字符串下标，js 腿与 c 腿都对）。真因见下一条。不过改成
   "收参数、回值的普通函数 + 模块级 Map"本身是对的（少一层、两条腿形状一致），就留下了。
2. **`lazy.js` 用 `treeRoot()` 拼路径是错的**：js-roundtrip 那条轴把整棵树重新生成到
   `.omni-build/js-roundtrip/` 下，那儿没有 `package.json` / `.git`，`treeRoot()` 退回
   "往上数三格"就指到了别处 —— 症状是 `session-asy.in [host crash]`。改成
   **相对这一份文件**（`createRequire(import.meta.url)` 的 base 就是它）之后那条轴转绿。

## 七、顺手挖出来的两笔既有欠账

想给这一刀加一条"产物真跑一趟"的判据，结果发现那条路**从来没绿过**。两笔都与按需装载无关，
一个已修、一个记账：

1. **`import { A as B }` 的改写不认局部遮蔽**（已修，见 `frontend-js/rename.js`）。
   `renameImports` 把 `B` 的引用改写成 `A`，而 `glr/lex.js` 里恰好有 `import { span as
   mkSpan }` + 函数体内 `const span = mkSpan(…)` —— 改写之后成了"调那格局部量"。
   于是**自己编出来的 omni 读任何借来的语言都炸在词法器里**（`.py` / `.go` / `.pss` 全中），
   而 `emit js` / `emit c` 一声不响地编过去。修完之后自编的 JS 产物**第一次**跑得动 `.py`。
2. **原生腿的正则引擎缺一格**（未修）：`./dist/omni run x.py` 现在报
   `regexp: negated class escape (\D \S \W) inside [...] is not supported`。
   python.grammar 的词法规则里有这种写法，而 `src/runtime/` 那份 C 正则还没收字符类里的
   否定类转义。这是"原生产物 × 借来的语言"这条组合上的下一格，与这一份文档无关。

**这两笔照出同一件事**：判据里长期缺"**自己编出来的那份真跑一趟借来的语言**"。
`check:self` 只管编得出，`tests/*` 都跑在 node 源码腿上。这条组合该有一格判据。

**另有一格环境陷阱**（不是回归，但会把人骗住）：`dist/plugins/` 一在场，**node 源码腿的
`tests/c` 就从 106 passed 变成 20 passed / 88 failed**。理由是 `plugin.js` 的
`noteUnloadable`：目录里躺着 `omni-lang-c.dylib` 时，node 腿认的是"c 这门语言装着插件，
而这条腿装不动它"（没有 dlopen），于是不再走内建那份迟装的 `lang/c.js`。
所以**跑 `tests/c` 之前别让 `dist/` 在场**（`npm run build:native` 会造出它）。
我在批 B 上被这一格骗了一轮，先以为是自己改坏了链接器。

### 第 3 刀（收尾，没有性能收益）：数据那半也挪进自述

把第 1 刀留在核心的那张纯数据表（十三行 `name` / `grammar` / `exts`）也挪进
`ext/<name>/omni-ext.json`：`provides` 加一栏 `borrow: { exts, grammar, asi }`，
`ext.js` 的 `checkManifest` 认它，`plugin.js` 加 `borrowExts` 这一 kind 与两个查询口
（`borrowExtsAll()` **只读声明不装**，给 `borrowedExts()`；`borrowLang(name|path)` 触发装载）。
于是 `lower/langs.js` 整个删掉，**加一门借来的语言只改 `ext/` 一处** —— ADR-0030 的终局。

排在最后，因为它一毫秒都不省：性能收益在第 1、2 刀里已经全部拿到。

## 六、不做什么

- **不用 `await import()`。** 我们自己的 JS 前端明着拒它（`the module graph is fixed at link
  time`），而且它会把 `pickLang` / `sxTextOf` / `runCli` 这条**同步**链整条染成 async。
- **不动 `.omni-cache/glr` 那张表的格式。** 磁盘命中那一趟仍要 `readGrammar` 37ms +
  `tableFromText` 70ms（`glr/load.js` 的文件头自己记着这笔账），那是**另一笔**——
  "表的装载形式"，不是"装了不该装的模块"。记在这儿，别混进来。
- **V8 编译缓存留着。** 它与按需装载不互斥：一个减单价、一个减份数。
- **不给宿主 ABI 加 `arch` / `os` 两格。** `uname` 那两次 spawn 已经并成一次
  （`unameOut` 一趟 `uname -sm` 答两个问题）；真要去掉最后那一次得动封闭 ABI 与三条腿的实现，
  那是 ADR-0011 决策 2 的账，不是这一份的。
