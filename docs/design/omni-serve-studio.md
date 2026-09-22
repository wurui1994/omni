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
GET  /studio.css /studio.js -> css / js（原生，零构建；从 `src/studio/` 直接发）
GET  /api/health            -> { ok, version, legs, pool }
GET  /api/tree              -> 虚拟文件树（见 §5.2），一次给全；**改过与新建的并在里头**
GET  /api/file?path=…       -> { path, lang, text, dirty? }（改过的那一份优先）
PUT  /api/file              -> { path, text }：**保存 / 新建**，写进虚拟文件系统
POST /api/run               -> { argv } 或 { lang, text, path, pkgs }；回 { stdout, stderr, code, via }
POST /api/emit              -> 同上 + `format`（ast/oir/mir/sx/js/c/…）
POST /api/shell             -> { line }；一整行命令（含 tcc/go/nim 等效命令），回同上
```

`via` 是 `warm`（热工人）还是 `cold`（子进程）—— Studio 的状态栏印它，"实时"这件事
得看得见。

### 虚拟文件系统是**可写的**（会话内）

仓库里一个字节都不动 —— 那是别人的工作树，编辑器不该往里写。两处落点：

* **`EDITS`（内存）**：`/api/file` 与 `/api/tree` 读它。用户看到的就是这一份。
* **镜像目录** `.omni-cache/work/studio-vfs/<同样的相对路径>`：编译器只会读真磁盘，
  所以跑之前把那一格写下去，再让它编镜像里那一份。

**镜像保持相对路径**，因为 `import` 同目录的兄弟文件与 `--pkgs` 那几个目录名都按路径算。
代价写在明处：镜像里只有**改过的**那几份，所以一份改过的文件若 import 了没改过的兄弟，
那个兄弟在镜像里不在 —— 例子都是单文件，这一条够用；不够用的那天要整棵 copy-on-write。

用户不用操心"保存"：切文件之前、`Cmd+S`、跑之前、页面隐藏时各存一把。

两条约定：

* **阶段耗时不在服务里重算**。请求那趟命令末尾自动加一格 `-v`，`stages.js` 印出来的那几行
  （`omni: …`）原样进 `stderr`，网页那一栏**照着念**。`src/core/cli/stages.js` 已经把
  "管线是数据"做完了（`newPlan` / `addStage` / `renderStage`），`--explain` 与 `-v` 是同一份
  数据的两种印法 —— 网页那栏是**第三种印法**，不另算一遍耗时，不在服务里重写一份格式。
  （欠账：还没有结构化的 `stages` 字段，前端按行解析。要那一格就让 `-v` 多一种 JSON 印法，
  仍旧是同一份数据。）
* **源码可以只在请求里**。`{ lang, text }` 那一档不落盘（落一格暂存目录就够，走
  `host/cache.js` 的 `scratchDir`）—— 网页上改一行就跑一趟，不该在仓库里留垃圾。

### 编译器怎么被调用

**热工人池** + 冷子进程当退路。

先量的账（一趟 `omni run x.go`，磁盘缓存全热，**180ms**）：

* **110ms** 宿主 + 装编译器（node 启动 + import 两百多份 ESM）
* **15ms** 读语法表（`glr/load.js` 磁盘缓存那一层：读一份几百 KB 的表再逐格解回来）
* 剩下 ~50ms 才是真编译 + 真跑

也就是说"每请求一个子进程"那一刀，**七成时间花在与这份源码无关的事上** ——
而实时模式只有 250ms 预算，全被启动吃掉了。

于是四刀（都在 `src/core/studio/`）：

1. `core/cli.js` 导出 **`runCli(argv)`**，自己跑那一句用 `OMNI_AS_LIB=1` 闸掉 ——
   它现在能被 import 而不执行（ADR-0018 分片 3 的欠账，这一刀还了）。
   不用"我是不是入口"那种判断：那要 `import.meta`，而它不在自编译的子集里。
2. `glr/load.js` 加**进程内**那层语法表缓存（键与磁盘那层一样，是语法的正文）。
   go 每趟 15ms -> **2ms**。
3. **`studio/worker.js`**（常驻工人）+ **`studio/pool.js`**（池子）：
   * 协议 NDJSON；**响应走 `writeSync(1, …)`**，绕开被换成收集器的 `process.stdout.write`
     —— 于是 fd 1 上只有协议帧，编译器与被跑程序的输出一个字节都不掺；
   * 一个工人一次只干一件事（模块级全局不串味）、跑够 64 趟就换、超时由池子数着直接杀
     （CLI 自己那格开发期时限在工人里是**关的** —— 它到点会给整个进程一枪，而那是常驻的）；
   * **只接热得住的动词**（`run` / `emit` / `ast` / `oir` / `sx` / `graph` / `interp`）。
     `build` / `c link` 要 spawn cc、要写盘，照旧走冷子进程 —— 快是加法，不是替换。
   * 不用 `worker_threads`：线程里的 `process.stdout` 是转发到父进程的管子，捕获不干净；
     子进程顺手还有"崩了只崩一个工人"。
4. `omni serve` 起来就**预热**一格工人。

量出来：第一趟 379ms（含工人启动），之后 **8~19ms**；实时模式连改 6 次每次 8~17ms。
`OMNI_STUDIO_WORKERS` 改池子大小（默认 `min(4, 核数-1)`）。

### 时限与并发

* 时限：走已有的那套（`docs/design/dev-deadline.md`）。**热工人里 CLI 自己那格时限是关的**
  （它到点给整个进程一枪），改由池子数着到点杀工人；冷那一条照旧用 `OMNI_TIMEOUT`。
* 并发：池子里 N 格工人各一条队；一格工人同时只有一格请求，所以模块级全局互不干扰。

## 3. `omni --client` —— CLI 连上去

`omni` 默认还是 CLI；`--client`（或 `OMNI_SERVER=http://…`）时把同一条 argv 发给
`/api/run`，把回来的 stdout/stderr/code 原样落地。

**判据只有一条**：同一条命令，本地跑与经服务跑，**stdout 逐字节相同、退出码相同**。
这一条把"服务面"钉死成"同一个编译器的另一个入口"，而不是第二份实现。

## 4. Omni Studio —— 网页

### 4.1 三个模式

* **展示模式 = 首页 / 画廊**（默认落在这儿）：一屏卡片，每格一张**真跑出来的图**。
  点一格进 IDE 打开那份源码。
  上哪几格由 `src/studio/gallery.js` 那张**策展的清单**说 —— **没有图的例子不上首页**
  （树上一百多份 `.asy` 里绝大多数是算术与打印，摆上来只会是一墙空白卡片）。
  三种腿各一种出图法：asy 跑一趟把 EPS 翻成 SVG、glsl 用离屏 WebGL2 截一张 PNG、
  html 直接 `<iframe srcdoc sandbox>`。
  清单是人挑的，"它确实出图"是机器判的（`tests/serve` 把 `kind:'asy'` 那几格真跑一趟，
  要求 stdout 以 `%!PS` 起头且翻成 SVG 后真有笔画）。
  **从前这一格是"IDE 把编辑关掉"** —— 那没道理：一进来先看一份看不懂的源码，
  而这一页最该先给人看的是"它真能画出东西"。
* **IDE 模式**：目录树 + 编辑器 + 运行 + 预览 + 阶段耗时 + 虚拟 shell。
* **控制台模式**（在做，任务 #109）：matlab / spyder / idle 那一种 —— REPL + 变量区 +
  绘图区。它是 IDE 模式的变体，不是第三份实现。

上一次挑的那一格记在 `localStorage`（`omni.mode`）里。

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
* **原生 HTML / JS / CSS**，一个依赖都不装、一步构建都不要。编辑器是**透明 textarea
  压在高亮层上**（`-webkit-text-fill-color: transparent` + 滚动同步）——
  不上 CodeMirror/Monaco（那会立刻把"单体 HTML"这件事变成打包工程），也不用
  `contenteditable`（它的光标与撤销栈要自己重写一遍，textarea 免费带着）。

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
| 虚拟文件系统 | `PUT` 写得进、`GET` 读得回（带 `dirty`）、新建的进树、**改完再跑答案跟着变**（那一条是"改了没有效果"唯一量得出来的形状）、`PUT` 拦路径穿越 |
| 热工人 | `/api/health` 报得出 `pool.served > 0`；**热的那一趟 < 150ms**（冷那一条是 180~300ms）；`via === 'warm'` |
| 网页 | 不装无头浏览器（那会带一整套依赖）：`tests/serve` 里只查"那一页拿得到、assets 拿得到、树的 JSON 结构对" |
| 单体 HTML | 拼出来的那份文件里**除 prelude 之外没有 `getBuiltinModule`**（prelude 是一大段源码文本，不是代码）；再拿 node 当浏览器壳子跑六门语言，输出与 `omni run --engine graph` 逐字节相同 |
| 时限 | `docs/design/dev-deadline.md` 那一套；热工人那侧改由池子数（见 §2） |

## 7. 分片（做的次序）

1. **`omni serve` 骨架**：`cmds.js` 加动词、`serve.js` 走 `process.getBuiltinModule('node:http')`
   （不进 check:self 的静态模块图）。`cli.js` 走子进程 `node src/serve.js`（与 `client.js`
   同一条理由：`fetch`/`await`/`node:http` 不该进 `check:self`）。
2. **`/api/tree` + `/api/file`**：虚拟文件树（先只读真磁盘）。
3. **`/api/run` + `/api/emit` + `stages`**：真跑起来。
4. **Studio 第一版**：目录树 + 只读展示 + 运行 + 阶段耗时（= 展示模式，移动端就绪）。
5. **IDE 模式**：编辑器 + 高亮 + 虚拟 shell + 实时模式。
6. **`omni --client`**：`src/client.js`（另一个 node 入口）+ `cli.js` 里 `--client` 块 + `serve.js` 里 `body.argv` 直通。
7. **`host/browser.js` + 打包脚本** -> 单体 HTML。

1–4 之后已经能用；5–7 是把它做完（1–6 已落地，7 在做）。

## 8. 已知的决策与欠账

* **每请求一个子进程**（`spawnSync`）：**已经换成热工人池了**（见 §2 那段量出来的账）。
  子进程那一条留着当退路（`build` / `c link` 那几格），所以两条路都在。
* **编辑器是"透明 textarea 压在高亮层上"**，而那一招有两个必须踩过才知道的坑，
  都量出来了、都写在代码里：
  * **只能有一个滚动容器**。`.code-body` / `#view` / textarea 三层都能滚的时候，
    "哪一层滚了"决定错位多少 —— 表现成**概率性的输入错位**。
  * **高亮层末尾要补一格 `\n`**：`<pre>` 会吞掉最后那个换行，textarea 不会。
  * 另加 IME 保护：拼字期间不触发实时跑。
* **"当前文本"与"上次对齐过的文本"必须是两格变量**。合成一格的代价是
  `dirty` 永远为假 —— **用户改了没有效果**，而且不报错。这一格只有
  "改完再跑，答案跟着变"那条判据量得出来。
* **不上 WebSocket**：第一刀 SSE 都不用；交互式 REPL 要的时候再加。
* **不上第三方编辑器**：`contenteditable` + 自己的高亮。代价是没有多光标/LSP，
  换来的是"零依赖、能塞进一份 HTML"。
* **原生那一档在浏览器里做不到** —— 见 §5，这是事实不是欠账。
* `cli.js` 那个巨型 `switch` 与模块级全局：子进程那一刀把并发这个维度**绕开了**
  （每趟一份新的全局）。哪天要进程内重入，账还在这儿。
