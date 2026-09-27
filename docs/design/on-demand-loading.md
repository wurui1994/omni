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

**cap 的名字与形状**：一门语言一格 `borrow.<name>`，回它的运行时那半：

```js
api.registerCap('borrow.python', () => ({ toIR: pyToIR, hooks: PY_HOOKS }));
// 可选那几栏：imports / pre / jsRuntime，谁有谁给
```

`cap('borrow.python')()` 与 `cap('c.sysInclude')()` 同形（`registerCap` 收的就是函数）。

**`drive.js` 的改法**（`sxTextOf` 开头两行）：

```js
const lang = pickLang(path, cliArg(argv, '--lang'));   // 纯数据，不装代码
const rt = cap(`borrow.${lang.name}`)();               // 到这一刻才装这一门
```
底下 `lang.toIR` / `lang.hooks` / `lang.pre` / `lang.imports` 全改成 `rt.*`。
`hasAdapter(lang)` 改成问 `hasCap('borrow.'+name)`（**只查声明、不装** —— `plugin.js` 那格
`hasCap` 刻意就是这个语义）。

**三条腿各自怎么装**（照 `builtin.js` / `builtin-fat.js` / `builtin-web.js` 那个接缝，一格不新造）：

- **node 源码腿**：每门语言加一份 `ext/<name>/omni-ext.json`（`provides.caps:
  ["borrow.<name>"]`）+ 一份薄入口 `ext/<name>/omni-lang.js`。`lang/builtin.js` 里那句
  `declareExts((dir, entry) => require_(join(dir, entry)), api)` 已经在扫了，**核心一行都不用改**。
- **浏览器腿**：`lang/builtin-web.js` 的 `STATIC_EXTS` 加十三行（页面里没有 `require`）。
  少了这一格，studio 里 `.pss` / `.kc` 会报"没这格扩展的代码" —— 那份文件头已经写着这条。
- **产物腿**（`emit js` / `emit c` / `dist/omni`）：新增 `lower/langs-fat.js`（十三条静态 import
  + 同一条 `declareProvider` 声明出去）与 `lower/langs-pick.js`，挂到 `cli.js` 的 `readModule`
  接缝上 —— 与 `builtin-pick.js` 同构。**产物里一格不少、行为一格不变**，省下来的是源码腿那 135ms。
  （为什么不直接让产物腿也走插件：那会把 `dist/omni run x.py` 从"能跑"变成"报没装"。那是
  ADR-0030 的终局，但它是**另一笔账**——要给 `PLUGIN_SET` 加十一格 `lang-*`——不混在这一刀里。）

判据：
- `node src/cli.js run --mode js -v /tmp/tiny.py` 的「启动」一栏掉 **≥130ms**；
  用 `--cpu-prof` 确认 `ext/` 下**只有 python 那一份** adapter 出现在栈里。
- `node tests/python/run.js`（14.6s 基线）不变红、跟着变快。
- `node tests/lower/run.js`、`node tests/glr/run.js`、`tests/c`（106 passed / 2 failed）不动。
- `npm run check:self` 绿；`npm run build:native` 编得出来，`./dist/omni run x.py` 照旧跑。
- `tests/lib/cases.js:828` 那句 `typeof d.toIR === 'function'`（拿它算"哪几门有 adapter"）
  要改成问注册表 —— 不然那张表会变空，整套判据静静少跑。

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

手法与第 1 刀**同一套**（声明 + 被问到才装），差别只在声明表放哪儿：这些是核心自己的部件，
不走 `ext/` 自述，而是往 `lang/builtin.js` 的 `BUILTINS` 表里加一类 `core-*` 声明
（`caps: ['link.macho']` 这种）。成本要写明：那张表**有三份**（`builtin.js` 迟装 /
`builtin-fat.js` 产物 / `builtin-web.js` 浏览器），加一格要改三处 —— 这是现有接缝的既定代价，
`resolvePending` 的核对机制会在走散时当场响。

预估省 **≥250ms**。这一刀调用点多（几十处），所以按上面的分组**一组一刀**地做，每组的判据是
「那一组的命令照旧过它自己那条测试轴」+「`tiny.py` 的启动再掉一格」。

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
