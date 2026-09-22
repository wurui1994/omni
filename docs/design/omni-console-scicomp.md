# 控制台模式与科学计算（第三种模式）

任务 #109。**两件事一起说**：Studio 的第三种模式（matlab / spyder / idle 那一种）与它下面
那套科学计算 + 绘图的库。后者照 gsl-shell 的依赖顺序补 ——
源码在 `/Users/wurui/Documents/Lang/reference/gsl-shell`（下面凡是带行号的都是照它抄的）。

## 1. 为什么是"变体"而不是第三份实现

已经有的东西，一样都不重写：

* **REPL 本体已经有了** —— `omni repl`（`src/core/cli/cmds.js:549`），判据四份会话
  （`tests/repl/session{,-sx,-asy,-js}.in/.expected`）。它已经会"一行一句、表达式自动印值、
  状态跨行留着"（`x = 10` 然后 `x * x` 印 100）。
* **服务与热工人池已经有了** —— `src/core/serve.js` + `src/core/studio/{pool,worker}.js`。
* **绘图的三条腿已经有了** —— asy 出 EPS（页面上翻 SVG）、glsl 走 WebGL2、
  三维那一路出位图（`omni_r3`）。
* **页面的版面已经有了** —— 展示 / IDE 两套（`docs/design/omni-serve-studio.md` §4.1）。

于是控制台模式 = **一套版面** + **一格会话 API** + **一张变量表** + 那套库。

## 2. gsl-shell 到底是什么（照源码，别猜）

* 它是 **LuaJIT + GSL 的薄壳**：科学计算那一侧几乎全是 Lua 写的 ffi 绑定
  （`gsl.lua` 是 cdef，`matrix.lua` 是主体），绘图那一侧是 C++ 的 AGG 光栅器
  （`agg-plot/lua-graph.cpp:55-72` 的 `register_graph` 是全部入口）。
* **没有 `vector`、没有 `linalg`** —— 向量就是 n×1 矩阵，线性代数挂在矩阵与 `num` 上。
* **没有变量浏览器**。全树 grep `whos|workspace|variable explorer` 零命中；
  FOX GUI 只有三种窗口：控制台 `fx_console.cpp`、绘图窗口 `fx_plot_window.cpp`、
  外壳 `gsl_shell_window.cpp`。最接近的是 `print` 那一套格式化（见下）。
  **所以变量区是我们自己加的一格**，不是抄来的。

### REPL 那几条真规矩（`gsl-shell-jit.c`）

* **续行**：`incomplete`（`:285-297`）—— 只认一条：`luaL_loadbuffer` 报语法错
  **且消息结尾正好是 `'<eof>'`**。攒行靠 `loadline:373-385`（插一个 `\n` 再 concat）。
* **自动印值**：`yield_expr`（`:324-349`）**每一行都先试一次 `return <行>`**，编得过就是表达式。
  行尾是 `;` 就放弃 —— 这正是 MATLAB 的分号抑制输出，语义一致。
* **上一个值叫 `_`**（不是 `ans`）：`dotty:410-412` 存全局 `_`；打印的是**全部**返回值。
  `=expr` 那种前缀语法**不存在**（标准 lua.c 里那句被删了）—— 既然每行都试 `return`，它没用。
* **错误**：`traceback`（`:176-187`）先试 `__tostring` 再 `luaL_traceback`；出错后强制一次全量 GC
  （`docall:200`）。Ctrl-C 靠 `lua_sethook` 在下一条指令抛 `"interrupted!"`（`:121-136`）。
* **显示协议**：`print` 全树只被覆盖一次 —— `iter.lua:130` 的 `print = myprint`，
  逐参数 `tos(v, 0)`。那个 **0 是"深展开"的开关**：table / cdata 只在 depth 0 时调 `t:show()`。
  矩阵的 `show` 是 `matrix_display_gen`（`matrix.lua:264-297`）：
  `eps = 平均量级 * 1e-9`（不是固定阈值）、小整数 `%.0f` 否则 `%.8g`、按最长串右对齐。
  gdt 表另有一套两趟算列宽（`gdt.lua:192-228`）。
  **复数标量没有 `__tostring`**（`complex_mt` 只有算术），抄的时候这一格要补。
* **锁**：两把 —— `exec_mutex`（Lua 状态）与 `agg_mutex`（AGG 对象）。REPL **只在等键盘那一小段**
  放开前者（`pushline:305-307`）；每个绘图窗口自己一条线程（`canvas-window.cpp:59-83`）。
  我们这边不需要这一套：页面里"绘图"是一张图片，不是一个窗口。

## 3. 那套库的依赖层次（照 gsl-shell 的真实次序）

从底到上，每一层标出"不做也能用"的程度 —— 这一列决定我们的阶段怎么切：

* **L0 ffi + cdef**（`gsl.lua`）：不能缺，除非换后端。**我们换后端** —— 我们没有 GSL，
  下面那几层要自己写（这正是"做一遍"的意义）。
* **L0' 小工具**：`check.lua`（`is_integer` / `is_real`）、`gsl-check.lua`（错误码 -> error）、
  `algorithm.lua`（排序，缺了只丢 `m:sort`）、`template.lua`（代码生成，可缺）。
* **L1 显示与类型名**（`iter.lua`）：**不能缺** —— `gsl_type` 注册表 + `tos` + 覆盖 `print`。
  所有"看得见"都靠它。控制台模式的变量区也靠它。
* **L2 矩阵**（`matrix.lua` + `matrix-power.lua`）：不能缺。向量 = n×1 矩阵。
* **L3a 特征值**（`eigen.lua`）：**完全可缺**（全树只有 `tests/eigentests.lua` 用）。
* **L3b 数值那一族**：`num.lua` 骨架，然后 `integ-init` / `fft-init` / `linfit` / `vegas` /
  `bspline` 各自往 `num` 上挂 —— **逐个可缺、互不依赖**。
* **L3c 随机**：`rng.lua` -> `rnd.lua` / `randist.lua` / `roots.lua`（demo 用得多）。
* **L3d 特殊函数** `sf.lua`（可缺，但手册第一个例子用了 `sf.gamma`）。
* **L4 绘图**：C++ 侧 `agg-plot/` + `graph-init.lua`。对外就四个构造函数
  （`graph.plot` / `canvas` / `path` / `text`，见 `lua-plot.cpp:88-91`、`lua-draw.cpp:82-89`）。
  **窗口那一层与"出一张图"那一层切得开**：`plot:save` / `plot:save_svg` 不经窗口。
* **L5 等值线 / 三维**（`contour.lua`、`plot3d.lua` + `pre3d/`）：全可缺。
* **L6 数据表 `gdt*` + 表达式 `expr-*`**：全可缺（那是 R 的 data.frame 那一路）。
* **L7 `help.lua` / `import.lua` / `demo-init.lua`**：全可缺。

## 4. 阶段

每一阶段都要有**一个能跑的最小例子**与**一格判据**；判据落在 `tests/repl/` 与
`tests/serve/`（不新起一套跑手）。

* **阶段 1 —— 会话 API**（**已落地**）：`/api/repl`（`{ session, line, lang, reset }` ->
  `{ out, err, ok, incomplete, vars }`）。会话住在**服务进程**里，不进热工人池 ——
  池子是"一趟一格、跑完就还"，而 REPL 的全部价值在于状态留着。
  最小例子：`x = 10` / `x * x` -> `100`，与 `tests/repl/session.in` 头几行同一个答案。
  判据：tests/serve 那七格（状态跨行、串、函数、认得出没写完、变量栏、两格会话不串味、reset）。
* **阶段 2 —— 版面**（**已落地**）：控制台那一套（命令行 + 变量区 + 绘图区），
  与展示 / IDE 同一条 `data-mode` 机制，三套互斥。上下键翻历史、`…` 提示符接续行、
  换语言或按那个圈箭头就开一格新会话。变量栏的格式化是纯函数（`formatValue` / `typeName`）。
  **单体 HTML 那一份明着说这一档要 serve** —— 它没拼解释器进去，不假装。
* **阶段 3 —— 矩阵（L1+L2）**：`matrix.new` / `*` / `+` / 转置 / 切片 / `show`。
  最小例子：`m = matrix{{1,2},{3,4}}` / `m * m` 印出右对齐的两行。
  判据：与 gsl-shell 的 `matrix_display_gen` 同样的排版规矩（eps 按平均量级、小整数 `%.0f`）。
* **阶段 4 —— 绘图（L4 的"出一张图"那一半）**：`plot` / `addline` / `save_svg`。
  页面上就是"绘图区多一张 SVG"。**不做窗口**（我们没有窗口，这一格是白得的）。
  最小例子：`p = plot(); p:addline(...)` 在控制台里出一条曲线。
* **阶段 5 —— 数值那一族（L3b 挑两格）**：`num.integ`（积分）与 `linfit`（线性拟合）。
  挑这两格是因为它们**答案有闭式**，判据不必靠眼睛。
* **往后**：L3c 随机、L3d 特殊函数、L5 三维、L6 数据表 —— 按需要，一格一格来。

**先不碰的**：`eigen` / `vegas` / `bspline` / `gdt` / `expr-*` —— 上面那一列写清了它们可缺。

## 5. 语言那一格

控制台里敲的是哪门语言？**两条都要，先后有别**：

1. **omni 主语言**（`omni repl` 现在的默认）—— 阶段 1/2 就用它，因为它现成。
2. **lua / gsl-shell**（`--lang` 现在只认 omni|sx|asy|js）—— 那门方言的短 lambda
   在控制台里特别顺手（`|x| x^2` 当一格函数实参）。gsl-shell 的例子现在**不用旗子就跑**
   （见 `ext/gsl-shell/omni-lang.js` 与 ADR-0037 那条方言例外）。

