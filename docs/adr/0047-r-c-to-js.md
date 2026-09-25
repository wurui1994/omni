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

### 3. 判据（`tests/r/cjs.js`，12 格）

* **摊平没改数**：摊出来那份用 `cc` 编，与 `Rscript` **逐字节相同**（66 行）。
  这道门先过，后面几道才说得清是谁的问题。
* **解释腿 == JS 腿，逐字节**（`tests/c/run.js` 的口径）。
* **JS 腿 vs `Rscript`**：66 格里 **51 格逐位相同**，最大误差 **2.99e-15**（`qtukey`
  —— 迭代求根，起点差一个 ulp 五步牛顿之后放大到这个量级），上界记死 1e-14，只许变小。
* **`runif` 逐位相同**：MT19937 是纯整数运算，libm 插不上手 —— 所以那三格一旦不同就不是
  精度问题，是线性内存里那 625 格状态被搬错了。
* **画出一张真图**：见下面"显示那一格"。

每一趟都先判**行数**（66 行）：空输出冒充"逐字节相同"是这个仓库栽过的跟头。

### 4. 显示那一格：SVG 到 stdout（已落）

目标里那句"显示部分尝试建立浏览器图形设备，要求正常渲染"，第一格**不必碰图形设备
API** —— 调研发现这个仓库里已经有一条零成本的路：程序把 `<svg …>` 印到 stdout，
Studio 的预览栏就当图挂上去（`src/studio/render.js:248` 认 `<svg` 开头、`:398`
逐块抠 `<svg>…</svg>`；`src/lib/plot.omni` 与 `turtle.omni` 已经这么干了）。

于是第二个驱动（`nmath-plot.c`）画两条曲线 —— `dnorm(x)` 与 `dt(x, 3)`，各 161 点，
坐标轴、刻度、图例齐全。**曲线上每一个数都是 R 自己的 C 算的，跑在 JS 腿上。**

* 坐标一律印到**三位小数**：两边的 libm 不是同一份，三位小数把那 1e-16 量级的差吃掉 ——
  于是"同一张图"这句话可以判**逐字节**，不必落到"看着差不多"。
* 三条腿（`cc` / 解释 / JS）画出来的 SVG **逐字节相同**，7547 字节。
* 两条曲线的 `points` 串与 `Rscript` 算的**逐字节相同**（尺子 `plot.R` **只给点串**，
  不重写一遍 SVG 骨架 —— 写两遍会飘，而骨架由三腿逐字节那道门管着）。
* **真能渲染**：本机光栅器（`qlmanage -t`）把它画成一张 26 KB 的 PNG，
  两条曲线、坐标轴、刻度、图例都在（`dt(x,3)` 峰更低、尾更厚，对）。

**这一格还不是"浏览器图形设备"**，差的是那张宿主导入表（见下面第 4 条）——
现在的形状是"程序把图当文本印出去，宿主负责画"，而设备是"程序调宿主的画笔"。

### 5. 显示那一格的第二半：真的交一帧（已落）

**`interp/libc.js` 里那张表就是宿主导入表** —— 这是这一刀最后想明白的一件事：
C→JS 那条腿上"对外世界"的全部出口就是它（`hasLibc` 认得的名字走宿主，别的当场报）。
所以"接一台设备"不必先造一套新机制，往那张表里加一格就够了：

```c
int omni_c_gfx_frame(const char *path, int w, int h, const unsigned int *fb);
```

**把一帧交出去** —— 帧缓冲按 `w × h` 写成一张 PNG，回写进去的字节数。一格像素是一个
`unsigned int`，按 `0xRRGGBB` 读。宿主那一侧是 `builtin.js` 的 `gfxFrameLin`，
它与方言那两档（`gfxFrame` / `gfxFrameP`）**共用 `gfxEmit`** —— 那是三档必须逐字节
一致的那段字节。单开一档而不是复用 `gfxFrameP`：那一档读的是方言的指针内存
（`ptrDv`）、一槽 8 字节，而这条腿的内存是 `linDv`、C 的 `unsigned int` 是 4 字节。

第三个驱动（`nmath-frame.c`）于是是一台**真设备上的程序**：自己在帧缓冲上逐列画那两条
曲线与坐标轴（图元全在内存里画，一趟只过一帧 —— 图形设备就是这个形状），再调
`omni_c_gfx_frame` 交帧，最后往 stdout 印一行 `#gfx png <路径> <宽> <高>`
（`src/studio/render.js:267` 认这行，于是在 Studio 里它就是 canvas 上的一张图）。

判据：**解释腿与 JS 腿交出来的两张 PNG 逐字节相同**（614 833 字节，480×320），
`#gfx` 那一行指得对，PNG 头对。看过图：两条曲线、坐标轴、刻度都在，
`dt(x,3)` 峰更低尾更厚。

### 6. 显示那一格的第三半：设备自己的笔（已落）

上面那一格还是"我画好一整帧，你存成图"。真正的图形设备是"**你替我画**"，
所以再往那张表里加一格：

```c
double omni_c_gfx_call(const char *name, const double *args, int n);
```

一格宿主调用：名字 + 一串 double，回一个 double —— **EVAL 两门语言的宿主面就是这个形状**
（名字表在 `src/core/host/gfx-cpu.js` 的 `gfxCall`：`cls` / `setcol` / `moveto` /
`lineto` / `setpix` / `refresh` / `xres` / `yres` / `mousx` / `keystatus` / `gl*` …）。
宿主那一侧是 `builtin.js` 的 `gfxCallLin`，转给 `globalThis.__OMNI_GFX` ——
**与 `.pss` / `.kc` 那两门用的是同一格设备，不是第三份实现**：

* node 上是 `host/gfx-cpu.js` 那一档 CPU 备选（`refresh` 自己写图 + 印 `#gfx`）；
* **浏览器里是 `src/studio/gfx-gl.js` 那台 WebGL2 设备**（`installGlDevice` 把它装在
  `globalThis.__OMNI_GFX` 上，带真的鼠标键盘事件与 rAF 帧循环）。

第四个驱动（`nmath-dev.c`）于是是**一份在浏览器图形设备上画 R 的分布函数的 C 程序**：
画布尺寸问设备要（`xres`/`yres`，页面上 canvas 多大就画多大），`moveto` 一次、
往后一路 `lineto`，折线交给设备画，最后 `refresh` 交帧。

判据：解释腿与 JS 腿交出来的两张 PNG **逐字节相同**（480×320，尺寸是问设备要的），
`#gfx` 那一行与 `dev 480x320` 都在。看过图：两条曲线是设备的笔画出来的。

**这一格就是目标里那句"建立浏览器图形设备"** —— 缺的只剩"把 R 自己的 `graphics`
设备结构体（`GEDevDesc` 那一套回调）接到这几个名字上"，而那要先过 `setjmp` 与
MIR 链接器两道坎（`src/main` 与 `grDevices` 都在那后面）。




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
4. **浏览器那台图形设备：两档都通了，接 R 自己的设备结构体还没到。**
   * 已经有的：`omni_c_gfx_frame`（交一帧，上面第 5 条）与 `omni_c_gfx_call`
     （设备自己的笔，第 6 条）—— 后者打到的就是 `.pss`/`.kc` 那两门用的同一格设备，
     浏览器里是 `studio/gfx-gl.js` 那台 WebGL2。
   * 还没有的：R 自己的 `GEDevDesc` 那一套回调（`line` / `polygon` / `text` /
     `metricInfo` …）往这几个名字上接 —— 那要先过第 1、2 两条（`grDevices` 在
     `src/main` 后面）。
   * 顺带记一条：程序把 `<svg …>` 印到 stdout，Studio 预览栏也当图挂上去
     （`src/lib/plot.omni` 已经这么干），**零宿主接口成本** —— R 的 `svglite`/`pdf`
     设备产生的正是这种纯文本。


## 账

* 122 份 `.c` 摊成 15 641 字节的 `nmath-lib.c`（`#include` + `#define`/`#undef`，
  不含 R 的源码本身），两个驱动各包它一次。
* 改名的 `static`：10 个名字、22 处。
* `node tests/r/cjs.js` 全过（16/16）：66 格数 + 一张 7547 字节的 SVG
  + 两张 480×320 的 PNG（交帧那一档与设备自己的笔那一档，各自两条腿逐字节相同）。
* 产物落 `.omni-cache/r-rt/js/`（约定：生成物不进版本库，也不进临时目录）。
