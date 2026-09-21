# `omni serve` 与 Omni Studio

这一份定三件东西的形状与边界：**`omni serve`**（常驻服务）、**Omni Studio**（网页）、
**单体 HTML**（一份文件，双击就开，不要服务）。先写清楚，再动手。

## 0. 一句话

`omni serve` 像 `ollama serve`：起一个常驻进程，对外一套 HTTP JSON API，顺带把网页端
（Omni Studio）挂在同一个口上。`omni` 本身**默认还是 CLI**；`--client` 时它把同一条命令
发给服务去跑。Studio 再往前一步：把依赖 node 的那一层换掉之后，整套东西塞进**一份 HTML**。

## 1. 三件东西，一条边界

| | 是什么 | 编译在哪儿跑 | 要 node 吗 |
|---|---|---|---|
| `omni serve` | 常驻进程：HTTP API + 静态网页 | 服务进程里（就是今天的编译器） | 要 |
| Omni Studio（连服务） | 网页 IDE / 展示台 | 服务那边 | 要（服务那侧） |
| 单体 HTML | 一份 `.html`，双击就开 | **浏览器里** | **不要** |

一条边界写在明处：**前两件是"把现有的能力露出来"，第三件是"给宿主加一条腿"**。
前两件不需要改编译器一行；第三件要写宿主的第四份实现（见 §6）。

## 2. `omni serve` —— 服务面

### 为什么是 HTTP + JSON

因为要同时喂三种客户：网页、`omni --client`、别人的脚本。HTTP 是唯一三边都不用解释的
东西。不上 WebSocket（第一刀）：`run` 的输出是一次性的，SSE 就够；真要交互式 REPL 再加。

### 端点

```
GET  /                      -> Studio 那一页（HTML）
GET  /assets/*              -> css / js（原生，零构建）
GET  /api/health            -> { ok, version, legs, langs }
GET  /api/tree              -> 虚拟文件树（见 §5.2），一次给全
GET  /api/file?path=…       -> { path, lang, text }
POST /api/run               -> { argv } 或 { lang, text, argv }；回 { stdout, stderr, code, stages }
POST /api/emit              -> 同上，但回某个中间形态（ast/oir/mir/sx/js/c/…）
POST /api/shell             -> { line, cwd }；一整行命令（含 tcc/go/nim 等效命令），回同上
```

两条约定：

* **`stages` 是一等公民**。`src/core/cli/stages.js` 已经把"管线是数据"这件事做完了
  （`newPlan` / `addStage` / `renderStage`），`--explain` 与 `-v` 是同一份数据的两种印法。
  网页那一栏是**第三种印法** —— 不另算一遍耗时，不在服务里重写一份格式。
* **源码可以只在请求里**。`{ lang, text }` 那一档不落盘（落一格暂存目录就够，走
  `host/cache.js` 的 `scratchDir`）—— 网页上改一行就跑一趟，不该在仓库里留垃圾。

### 编译器怎么被调用

今天 `src/core/cli.js` **不能被 import 而不执行**（模块末尾就 `main(procArgs())`，
`src/cli.js` 的头注里记着这一格，ADR-0018 分片 3 的欠账）。所以 serve 的第一刀就是补它：

* `cli.js` 导出 `main(argv)`；
* 进程级那几件事（`setExitCode`、profile 收尾、顶层 try/catch）挪到 `src/cli.js`。

之后 serve 里跑一条命令就是**进程内重入** —— 现成的 `subMain(argv)` 已经在了
（`MAIN_NEST`，内层不重置全局开关）。stdout/stderr 要能捞出来：`host/native.js` 的
`stdout`/`stderr` 加一格**可替换的收集器**（一格函数指针，默认写进程），这是宿主 ABI 上
最小的一处改动。

### 时限与并发

* 时限：走已有的那套（`docs/design/dev-deadline.md`）。服务里每个请求**必须**带时限 ——
  一个不收敛的例子不能把服务拖死。默认沿用 `OMNI_TIMEOUT`（30s），请求里可以更小。
* 并发：第一刀**串行**（一把锁）。理由是编译器有一堆模块级全局（`VERBOSE`/`SRC_SX`/
  `IMPORTS` 那一族），并行重入会互相串味。要真并行就每请求一个子进程 —— 那是第二刀，
  有量了再说。

## 3. `omni --client` —— CLI 连上去

`omni` 默认还是 CLI；`--client`（或 `OMNI_SERVER=http://…`）时把同一条 argv 发给
`/api/run`，把回来的 stdout/stderr/code 原样落地。

**判据只有一条**：同一条命令，本地跑与经服务跑，**stdout 逐字节相同、退出码相同**。
这一条把"服务面"钉死成"同一个编译器的另一个入口"，而不是第二份实现。

## 4. Omni Studio —— 网页

### 4.1 两个模式

* **展示模式**（移动端默认）：只读。左边目录树、右边源码 + 运行结果 + 阶段耗时。
  为什么移动端默认它：手机上编译本来就难受，而"看得懂"是第一位的。
* **IDE 模式**：加编辑器、虚拟 shell、实时模式。一个开关切过去，桌面端默认它。

### 4.2 目录树 = 虚拟文件系统

树的内容是**仓库里已经有的东西**，不另写一份：

* **文档** —— `docs/`：40 份 ADR + 12 份 design + `guide.md` / `EXTENSIONS.md` / `notes/`
* **各语言的例子** —— `ext/<语言>/examples/`，146 份：
  go 29 / vlang 31 / nim 20 / lua 12 / mojo 12 / sbcl 10 / chez 9 / cpp 9 /
  freebasic 7 / awk 5 / gsl-shell 2
* **判据里的例子** —— `tests/<腿>/cases/`，一千多份（jnc 413 / asy 379 / js262 118 /
  sexpr 97 / js-exec 61 / go 33 / glsl 15 / wat 12 / glr 8 / gpu 4 / cabi 2）。
  它们带 `.expected`，所以**天生是"能运行、答案已知"的例子** —— 展示台要的正是这个。

虚拟文件系统一格接口（`readText` / `readDir` / `exists` 三个就够），两份实现：
服务那份读真磁盘，单体 HTML 那份读内联进去的一张表。

### 4.3 虚拟 shell

一个输入行 + 一块滚动输出，行为像 IDE 里那个终端。认三类命令：

1. `omni …` —— 原样发给 `/api/shell`；
2. **别的语言的等效命令** —— `tcc a.c -o a`、`go run x.go`、`nim c x.nim`、`lua x.lua`…
   翻成对应的 omni 命令再跑。这不是新东西：`src/core/cli/cmd-tcc.js` 已经把
   `omni c tcc` 那一套做过了（自己一套 tcc 参数解析 → 翻成 omni 命令 → 原路走一遍），
   这儿照它加一张小表；
3. `ls` / `cat` / `cd` / `clear` —— 虚拟文件系统上那几格，纯前端。

**输出有两个地方**（用户要的）：shell 里一份（像 IDE 跑命令），展示区一份（结构化：
stdout / stderr / 阶段耗时分栏）。同一份数据两种印法 —— 与 `stages.js` 同一条纪律。

### 4.4 实时模式

一格可勾选的开关。勾上之后：编辑停下 250ms 就发一趟，结果与**每阶段耗时**直接刷新。

三条要紧的：
* **防抖 + 只保留最后一趟**（旧请求的回包丢掉，不然结果会跳回去）；
* 服务那侧串行 + 时限（§2），所以实时模式不会把服务压垮；
* 阶段耗时那一栏就是 `stages` —— 改一行代码，哪一层变贵了**看得见**。这是这个模式
  真正的价值，不是"少按一次按钮"。

### 4.5 语法高亮

**自己写，一张小表一门语言**：关键字集合 + 注释形状 + 串的形状 + 数字。
不上第三方（要零依赖、零构建，而且我们本来就有每门语言的记号表）。
第一刀覆盖：omni/sx、go、c、lua、nim、v、asy、js、awk、lisp/scheme、basic、mojo、cpp。

### 4.6 UI

* **柔和的 Apple 风**：大圆角、克制的阴影、`-apple-system` / `SF` 字体栈、
  分层的半透明背景、`prefers-color-scheme` 跟系统深浅。
* **强调色可调**：一格 CSS 变量（`--accent`）+ 一排色板，选了记在 `localStorage`。
* **原生 HTML / JS / CSS**，一个依赖都不装、一步构建都不要。编辑器用
  `contenteditable` + 自己那层高亮（不上 CodeMirror/Monaco —— 那会立刻把"单体 HTML"
  这件事变成打包工程）。

## 5. 单体 HTML 模式

一份 `omni-studio.html`，双击就开，**不需要服务**。要做的事只有一件：**给宿主加第四条腿**。

### 已经是纯的（浏览器里直接能用）

`src/core/host/` 下这几份**不在封闭 ABI 上**、一行 node 都不碰：
`path.js` `hash.js` `utf8.js` `json_read.js` `cache.js` `data.js` `src_eval.js` `ffi_host.js`。

### 要换的那一层

`src/core/host/native.js` 是**封闭 ABI**（57 个导出），今天有三份实现：

| 腿 | 实现 |
|---|---|
| node | `src/core/host/native.js` |
| JS 产物 | `src/core/backend-js/prelude.js` 的 `$js_*` |
| 原生 | `src/runtime/omni_js_host.c` 的 `omni_js_*` |

浏览器是**第四份**：`src/core/host/browser.js`。分三档：

* **能做**：`readText`/`readDir`/`exists`（读内联的那张表）、`stdout`/`stderr`（写进
  页面的输出区）、`nowMs`/`upMs`、`env`（读 `localStorage`）、`args`、`cwd`、
  `hasJsEngine`（真）、`evalJs`（`new Function`）、浮点排版那一族（纯计算，照抄）。
* **写**：写进内存里那张表（会话内有效），不落磁盘。
* **做不到，明着拒**：`spawn`/`spawnIn`（没有子进程）、`pluginLoad`、原生 `cc`/链接。
  所以单体 HTML 里能跑的是**解释器与图那几条腿**（`--interp`、`--engine graph`、
  `--backend js`），原生那一档在页面上只能给出"这一步要 serve"。这是**事实，不是欠账** ——
  浏览器里没有 `fork`。

名字与 op 的对照表在 `src/core/frontend-js/link.js`（那份**不进产物**，只登记
"名字 → op"），所以换宿主**编译器本体一行不改**。

### 怎么变成一份文件

一个小脚本（`tools/bundle-studio.mjs`）：把编译器那棵 ESM 依赖图按拓扑序拼成一份
`<script type="module">`，`native.js` 换成 `browser.js`，再把虚拟文件树的内容
（文档 + 例子，选一个子集）序列化成一张表内联进去。**虚拟文件系统是例外** ——
它本来就该内联，不算"抽离 node 依赖"。

## 6. 判据

| 轴 | 怎么量 |
|---|---|
| 服务面 | `tests/serve/`：起服务、打每个端点、比 JSON 形状；**`/api/run` 与本地 `omni run` 的 stdout 逐字节相同** |
| client | 同一条命令两种跑法，stdout + 退出码相同 |
| 网页 | 不装无头浏览器（那会带一整套依赖）：`tests/serve` 里只查"那一页拿得到、assets 拿得到、树的 JSON 结构对" |
| 单体 HTML | 拼出来的那份文件里**一个 `node:` 都不许出现**（grep 判据）；再拿 node 当浏览器壳子跑几个例子（`--input-type=module`），输出与 `omni run` 相同 |
| 时限 | `docs/design/dev-deadline.md` 那一套，服务里每个请求都带 |

## 7. 分片（做的次序）

1. **`cli.js` 导出 `main`**（把进程级那几件事挪到 `src/cli.js`）+ stdout/stderr 可收集。
   这一刀单独走，因为它动的是所有人的入口。
2. **`omni serve` 骨架**：`cmds.js` 加动词、`node:http` 起服务、`/api/health` + 静态文件。
3. **`/api/tree` + `/api/file`**：虚拟文件树（先只读真磁盘）。
4. **`/api/run` + `/api/emit` + `stages`**：真跑起来。
5. **Studio 第一版**：目录树 + 只读展示 + 运行 + 阶段耗时（= 展示模式，移动端就绪）。
6. **IDE 模式**：编辑器 + 高亮 + 虚拟 shell + 实时模式。
7. **`omni --client`**。
8. **`host/browser.js` + 打包脚本** -> 单体 HTML。

1–5 之后已经能用；6–8 是把它做完。

## 8. 已知的决策与欠账

* **串行 vs 每请求一进程**：第一刀串行（编译器有模块级全局）。要并行先量"一趟多少毫秒"。
* **不上 WebSocket**：第一刀 SSE 都不用；交互式 REPL 要的时候再加。
* **不上第三方编辑器**：`contenteditable` + 自己的高亮。代价是没有多光标/LSP，
  换来的是"零依赖、能塞进一份 HTML"。
* **原生那一档在浏览器里做不到** —— 见 §5，这是事实不是欠账。
* `cli.js` 那个巨型 `switch` 与模块级全局：serve 把它们暴露在了并发这个新维度上。
  今天用一把锁绕过去，账记在这儿。
