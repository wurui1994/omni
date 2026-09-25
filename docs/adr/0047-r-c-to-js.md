# ADR-0047：R 的 C 到 JS —— 先把 nmath 摊平过一遍，四道结构性的坎摆在明面上

状态：进行中（第一刀已落：`src/nmath` 122 份 C 在 JS 腿上跑出 66 格数，与 `Rscript` 的差有上界）

## 背景

ADR-0046 定的是 **libR 档**：r-source 的 C 由我们编成 `libR.dylib`，R 在它上面跑，窗口走
R 自己那份 quartz。那一档是**原生**的 —— 它链本机的 libm、用本机的 `setjmp`、要
gfortran 编 BLAS/LAPACK。

这一刀问的是另一件事：**同一批 C，能不能经我们自己的 C 前端到 JS 腿上跑？**
如果能，R 就能进浏览器 —— 而"进浏览器"是这条路上唯一还没有答案的方向
（quartz 那一格只解决了本机窗口）。

管子是现成的，而且已经有门：`src/core/frontend-c/`（tccpp + tccgen 的等价物）→ MIR →
`src/core/mir/emit_js.js`（线性内存 + 结构化控制流 → 真 JS 控制流），`tests/c/run.js`
拿 30 份 `tests/c/gen/*.c` 判"JS 腿 == 解释腿"逐字节，而解释腿另有一道门判它与
`tcc -run` 逐字节。**在这一刀之前，`ext/r` 一行 C 都没走过这条管子** ——
`ext/r/build.js` 与 `ext/r/build-libR.js` 用的是本机 clang/gfortran。

## 决定

**先只摊 `src/nmath`，把它摊实**，别的四块记账不做。

选 nmath 是因为它是 R 里唯一**三样都不沾**的一块：没有 `setjmp`/`longjmp`、没有 `SEXP`、
没有 Fortran。它又不是玩具 —— 120 份 `.c`、R 全部的分布函数与 bessel 一族，而且它的答案
有一把现成的尺子（`Rscript` 自己）。

## 怎么落的

### 1. 摊平（`ext/r/cjs/gen.js`）

C→JS 那条腿是**单翻译单元**的（MIR 层没有链接器）。所以 120 个翻译单元要摊成一份，
跨三道坎，每一道都是"摊平"这件事本身的账，与我们的编译器无关：

* **文件局部的 `#define` 会漏到下一份。** `lgammacor.c` 的 `#define xbig …` 撞上
  `gamma_cody.c` 的 `const static double xbig = 171.624;`。每份包完就把它 `#define`
  过的名字全 `#undef`。
* **同名的 `static` 会撞车**（量出来 10 个名字、22 处）。`wilcox.c` 与 `signrank.c` 各有
  一个签名不同的 `w_init_maybe`；四份 `q*.c` 各从 `qDiscrete_search.h` 宏出一个
  `do_search`。算出"出现在一份以上"的那些名字，只给那几个按文件名挂后缀。
* **顶层 `omni run x.c` 只收 `-I`，不收 `-D`。** 所以 `MATHLIB_STANDALONE` 与
  `HAVE_CONFIG_H` 写进生成出来的文件头。

摊平**不改 R 的源码一个字**：改名走 `#define`，撤销走 `#undef`。

### 2. 补 libm（`src/core/interp/libc.js`）

在这之前解释腿与 JS 腿**一个 libm 函数都没有** —— `dnorm(0.5,0,1,0)` 走到第一句
`ISNAN(x)`（macOS 展成 `__isnand`）就报 "C ABI call not supported"。

补的是那张宿主 libc 表（两条腿共用它）：C99 的 double 一族、macOS 的
`__isnand`/`__signbitd`/`__fpclassifyd` 一族、`f` 与 `l` 两套后缀（这台目标上
`long double` 就是 double），以及三格自己写的 —— `lgamma`（Stirling + Bernoulli 项，
R 在 `lbeta.c`/`pnchisq.c`/`stirlerr.c` 三处**直接调平台的 `lgamma`**）、
`nextafter`（只能在位模式上做）、`__cospi`/`__sinpi`/`__tanpi`（苹果的扩展，
R 探到 `HAVE___COSPI` 就转给它们；半整数那几格要精确）。

**于是 libm 在这个仓库里有三份，这一条要一直摆在明面上：**

1. 原生腿链本机那一份（`libomniRmath` 就是它）；
2. `--libc self` 用我们自己写的 `src/sysroot/libc/math.c`（误差量在 `tests/c/libc-libm.js`）；
3. 解释腿与 JS 腿走宿主 JS 的 `Math`（这一刀补的）。

三份**不逐位相同**（`sqrt` 与取整那一族是 IEEE 规定的，所以相同；`exp`/`log`/`pow`/三角
各自的多项式不同）。所以这一档的判据不是逐字节。

### 3. 判据（`tests/r/cjs.js`，8 格）

* **摊平没改数**：摊出来那份用 `cc` 编，与 `Rscript` **逐字节相同**（66 行）。
  这道门先过，后面几道才说得清是谁的问题。
* **解释腿 == JS 腿，逐字节**（`tests/c/run.js` 的口径）。
* **JS 腿 vs `Rscript`**：66 格里 **51 格逐位相同**，最大误差 **2.99e-15**（`qtukey`
  —— 迭代求根，起点差一个 ulp 五步牛顿之后放大到这个量级），上界记死 1e-14，只许变小。
* **`runif` 逐位相同**：MT19937 是纯整数运算，libm 插不上手 —— 那三格一旦不同就不是
  精度问题，是线性内存里那 625 格状态被搬错了。

每一趟都先判**行数**（66 行）：空输出冒充"逐字节相同"是这个仓库栽过的跟头。

## 还没解决的四道坎（往 ggplot2 走要先过这些）

1. **`setjmp`/`longjmp` 在 JS 腿上是拒绝的。** `emit_js.js` 有 `JS_NOJMP`，撞上就抛。
   而 R 的错误/中断机制整个建在它上面（`errors.c` 的 `R_ToplevelExec`、`context.c` 的
   `RCNTXT` + `R_jumpctxt`、`Rf_error` → `jump_to_top_ex`）。**MIR 解释腿是有
   `LongJmp` 的**（`mir/interp.js`），所以这一格是"JS 发射器还没做"，不是"模型上做不到"
   —— 结构化控制流里跨函数跳只能靠 JS 的异常，那是一刀正经的活。
2. **单翻译单元。** nmath 摊得动是因为它 122 份、互相只靠头。`src/main` 是 ~99 份
   加 `src/appl`/`src/unix`/`src/extra/tre`/tzone，而且 `static` 撞车会多得多 ——
   到那一步该做的是 MIR 层的链接器，不是更聪明的摊平脚本。
3. **没有 Fortran。** R 的 `SOURCES_F` 与 BLAS/LAPACK 都是 Fortran。nmath 恰好不沾。
4. **浏览器那台图形设备还没有。** 调研的结论是**地基已经在**，缺的是接头：
   * `src/studio/gfx-gl.js` 是一台真设备（WebGL2 + 真事件），装法是
     `globalThis.__OMNI_GFX = dev`；
   * 离线一帧走 stdout 上的一行 `#gfx <png|rgba> <路径> <宽> <高>`，
     `src/studio/render.js` 认这行并 `putImageData` 贴到 canvas；
   * **还有一条零成本的路**：程序把 `<svg …>` 印到 stdout，Studio 预览栏就当图挂上去
     （`src/lib/plot.omni` / `turtle.omni` 已经这么干）。R 的 `svglite`/`pdf` 设备
     产生的正是这种纯文本 —— 所以"R 画图进浏览器"的第一格**可以不碰图形设备 API**。
   * 而 C→JS 那条腿目前**没有通用的宿主导入表**：产物只导出一个 `$run()`，
     对外世界只有一张写死的 libc 表。要让 R 的设备回调打到 canvas 上，得先有那张表。

## 账

* 122 份 `.c` 摊成 19 797 字节的一份 `.c`（`#include` + `#define`/`#undef`，不含 R 的源码本身）。
* 改名的 `static`：10 个名字、22 处。
* JS 腿一趟 66 格：`node tests/r/cjs.js` 全过（8/8）。
* 产物落 `.omni-cache/r-rt/js/`（约定：生成物不进版本库，也不进临时目录）。
