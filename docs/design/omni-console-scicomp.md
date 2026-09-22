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
* **阶段 3 —— 矩阵（L1+L2）**（**已落地**：`src/lib/matrix.omni`）：
  `matZeros` / `matOf` / `matVec` / `matEye` 四个口子，`Matrix` 上
  `get` / `put` / `add` / `sub` / `mul` / `scale` / `t` / `solve` / `inv` / `det` / `text` / `show`。
  **用 Omni 自己写**（与 `json.omni` 同一条理由）：gsl-shell 那层是 GSL 的 ffi 绑定，
  我们没有 GSL，所以乘法与消元自己写 —— 消元带**部分选主元**（不选的话 `[[0 1][1 0]]`
  一上来就除以 0）。印法照 `matrix_display_gen`：eps 按平均量级、小整数印整数、右对齐。
  两处刻意与它不同并记在文件头：**下标从 0 起**（这门语言的 `list` 是 0 起，
  为"matlab 手感"改成 1 起只会与宿主的每处下标打架）、非整数 6 位有效数字（宿主的印法）。
  判据：`tests/cases/26_matrix.omni`（五条腿差分 + 快照，答案逐个手算核对过）
  + tests/serve 三格（控制台里 `matOf` / `det` / 乘法排版 / 变量栏认得出它）。
  **控制台的会话走 `mixed` 模式**：`dynamic` 里 `[[1.0, 2.0], …]` 推不成
  `list<list<real>>`，`matOf` 当场报"没有匹配的重载"（量出来的）。
* **阶段 4 —— 绘图（L4 的"出一张图"那一半）**（**已落地**：`src/lib/plot.omni`）：
  `plotNew` / `plotLine`，`Plot` 上 `addline` / `svg` / `show` + `title` / `xtitle` / `ytitle`。
  出来的是**一份 SVG 文本**，页面看输出决定挂哪儿（`<svg` 起头就进绘图栏 —— 与 asy 那条
  "看是不是 `%!PS`"同一条纪律）。**不做窗口**：gsl-shell 那边一窗口一线程、两把锁，
  而它自己也留了不经窗口的口子（`plot:save_svg`）—— 我们只要那一半，那套线程与锁一格不用。
  刻度是"好看的数"（1/2/5 × 10^k），实现里**一个 log 都没有**（不是因为没有 ——
  `log10` 是内建；是整十进位一档一档乘除在边界上更稳，差一个 ulp 就会挑错一档），
  按十进位一档一档乘除）。
  判据：`tests/cases/27_plot.omni`（**整份 SVG 的 js==c 差分 + 快照**）+ tests/serve 一格。
  差分那一轴当场抓到一个真 bug：`plotEsc` 从前一个字一个字搬，而"一个中文字"在两条腿上
  不是同一件事（C 那侧是字节、JS 那侧是 JS 串），`plotNew("两条")` 在 js 腿上印成一串问号。
  改成**按整段拷**（要转义的三个字都是 ASCII，切口只落在 ASCII 上）之后两条腿逐字节相同。
* **阶段 5 —— 数值那一族（L3b 挑两格）**（**已落地**：`src/lib/num.omni`）：
  `numInteg`（复合 Simpson + 加倍到收敛）、`numSimpson`、`numLinfit`（多项式最小二乘）、
  `numPolyAt`。挑这两格是因为**答案有闭式**，判据不必靠眼睛：
  `∫₀¹ x² = 1/3`、`∫₀² x³ = 4`（Simpson 对三次以下是精确的）；喂给拟合的点来自真多项式，
  系数原样出来（`y = 2 - x + 0.5x²` 出 `2 / -1 / 0.5`）。
  照它的一个真实事实：gsl-shell 的 `num.integ` **不是** GSL 绑定，而是纯 Lua 重写的 qag
  （`templates/qag.lua.in` 开头写着 "Adapted from the GSL Library, version 1.14"）——
  所以这一层自己写不是偷懒。`linfit` 那边它包 `gsl_multifit_linear`（走 SVD），
  我们走正规方程 + 自己的消元，**高次上条件数差**这一格在文件里照实写着
  （QR 现在做得了 —— `sqrt` 是内建了 —— 只是还没做）。
  后来又加了 `numRoot`（求根：**二分保底 + 试位法加速**，两端必须异号，不异号当场报）。
  gsl-shell 那边求根也是纯 Lua（`roots.lua` 的 Brent），我们收的是它的骨架不是全套 Brent。
  判据：`tests/cases/28_num.omni`（js==c 差分 + 快照，答案全是闭式核对：√2 / 2 / Dottie 数）。
  顺手一格语言事实：**import 不是传递的** —— 用 `numLinfit` 的文件得自己再 import 一次矩阵。

## 4.5 数学那一族（主语言的内建，**这一层原来是空的**）

`sqrt` / `abs` / `floor` / `ceil` / `round` / `pow` / `fmod` / `hypot` / `cbrt` /
三角那八个 / `exp` / `log` / `log10` —— 全在 `hir/check.js` 的 `MATH_FUNCS`。

**一格都不新写**：核心方言早就有 `(rmath "NAME" …)`，落到的节点是
`{ kind: 'Builtin', name: 'rmath_<名字>' }`，五条腿全认（C 走 libm、JS 走 `Math.*`，
名单是 C99 math.h 与 ECMA-262 的交集）。这一层只是**把那扇门开在主语言上** ——
从前 `sqrt(9.0)` 报 `undefined function 'sqrt'`，而降级器手里明明有它。

三条规矩：
* 名字取人写得出来的那个（C 的 `fabs` 在这儿叫 `abs`）；
* 参数一律按 real 算（`int` 走隐式加宽，`sqrt(16)` 收得下）；
* **回的一律是 real**，包括 `floor` / `round` —— 要 int 自己写 `int(floor(x))`，
  让那次截断看得见。

判据 `tests/cases/29_math.omni`：闭式的那些逐个比，**边界那几格靠 js==c 差分**
（`round(-2.5)` 照 C 是 -3 不是 JS `Math.round` 的 -2；`pow(-8, 1/3)` 是 nan
而 `cbrt(-8)` 是 -2；`fmod(-7, 3)` 是 -1）—— 两条腿逐字节相同，所以那一族的语义是**同一份**。

## 4.6 阶段 6 —— 复数与 FFT（**已落地**：`src/lib/complex.omni` + `num` 那两格）

这是矩阵之后欠得最久的一格（从前这一列写着"欠的最要紧那一格是复数"）。

* **复数**（`src/lib/complex.omni`）：`Complex` 上 `add` / `sub` / `mul` / `div` / `scale` /
  `conj` / `abs` / `norm2` / `arg` / `text`，加 `cxOf` / `cxPolar` 两个口子。
  gsl-shell 那边复数不是库而是 LuaJIT 的 `complex` cdata（`matrix.lua:13`），
  算术走 ffi 的元方法，库里只补 `conj`/`real`/`imag`/`norm2`（`matrix.lua:185-205`）——
  我们没有那格 cdata，所以自己写。**补了它缺的一格**：那边 `complex_mt` 没有 `__tostring`，
  于是 `print(1+2i)` 印的是 `cdata<complex>: 0x…`；这边 `text()` 印 `3+4i` / `-i` / 纯实数。
  除法走 **Smith 的两支**（拿分母里大的那个约），不是 `(ac+bd)/(c²+d²)` —— 后者在大数上
  中途溢出成 inf（C99 的 `_Cdiv` 与 LAPACK 都是这一招）。
* **FFT**（`numFft` / `numFftInv`）：**照抄它对外的形状，不照抄它的存储**。
  gsl-shell 回的是 half-complex（实虚挤在一块 `double[n]` 里），但**用它的人看见的是
  `ft[k]` 一格一个复数**（`halfcomplex_radix2_index`，`fft-init.lua:182-195`）——
  我们直接回那个：一串 `Complex`。两条腿也照它分：n 是 2 的幂走 radix-2（位反序 + 蝶形），
  不是就走一遍朴素 DFT（它那边是混合基）—— **慢但答案对，不报错、不假装**。
  1/n 那个因子放在逆变换上（与 GSL 同），所以 `numFftInv(numFft(x))` 就是 `x`。
* 判据 `tests/cases/30_fft.omni`（js / c / interp / interp-mir 四条腿 + 快照）。
  **这一份只印有话可说的量**：FFT 的答案里满是 1e-16 那一档的残渣，直接印就是拿两条腿的
  `libm` 与 `Math.*` 的最后一位赌运气。所以印的是 `round` 过的整数（常数序列的谱 =
  `[n,0,0,…]`、一个周期 cos 的谱 = 两格 n/2）、往返的 `< 1e-12` 这个**判断**、
  以及朴素 DFT 那条腿上有闭式的 `6` 与 `-1.5 ± i√3/2`（截 6 位）。
  复数的算术本身是精确的（四则），那几行照印。tests/serve 另有一格走控制台。

* **往后**：L3c 随机、L3d 特殊函数、L5 三维、L6 数据表 —— 按需要，一格一格来。

**先不碰的**：`eigen` / `vegas` / `bspline` / `gdt` / `expr-*` —— 上面那一列写清了它们可缺。

## 5. 语言那一格

控制台里敲的是哪门语言？**两条都要，先后有别**：

1. **omni 主语言**（`omni repl` 现在的默认）—— 阶段 1/2 就用它，因为它现成。
2. **lua / gsl-shell**（`--lang` 现在只认 omni|sx|asy|js）—— 那门方言的短 lambda
   在控制台里特别顺手（`|x| x^2` 当一格函数实参）。gsl-shell 的例子现在**不用旗子就跑**
   （见 `ext/gsl-shell/omni-lang.js` 与 ADR-0037 那条方言例外）。

