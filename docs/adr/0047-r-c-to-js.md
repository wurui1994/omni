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

1. **~~`setjmp`/`longjmp` 在 JS 腿上是拒绝的~~ —— 这一格已经落了（见下面第 7 条）。**
2. **单翻译单元。** nmath 摊得动是因为它 122 份、互相只靠头。`src/main` 是 ~99 份
   加 `src/appl`/`src/unix`/`src/extra/tre`/tzone —— 这一格**量过了**（2026-09-25 的
   一次探底，`cc -fsyntax-only` 数错误）：
   * 照原样叠 99 个 `#include`：**1444 条错**；
   * 加上 nmath 那套机械活（每份包完 `#undef` 它的宏 + 撞车的 `static` 按文件挂后缀
     + 把 `R_USE_SIGNALS` / `USE_RINTERNALS` 这两个"头的旋钮"提到最前面）：
     **降到 490 条**，12 类。
   * 剩下那几类说明**textual 改名在这个规模上是错的工具**：
     - `src/main/arithmetic.h` 这种**没有 include guard、体里带 `static R_INLINE`
       函数**的内部头，被两份 `.c` 各包一次就是重定义；
     - `connections.c` 与 `dounzip.c` 各有一个 `NORET static int null_vfprintf`
       —— 前缀带属性，"行首 static"的正则看不见；
     - 最说明问题的一格：`eval.c` 里有个 static 叫 `expr`，按文件改名之后
       `#define expr expr__eval` 把 `Defn.h` 的 `PRCODE(x) ((x)->u.promsxp.expr)`
       一起改了 —— 宏是文本的，它不知道哪个 `expr` 是结构体成员。
   * 所以判断是：**到 `src/main` 这一步该做的是 MIR 层的链接器，不是更聪明的摊平脚本。**
     摊平在 nmath 上是几十行的机械活（那儿 0 错），在 `src/main` 上是与 C 的
     预处理模型作对。
   * **这一条同时是 R 编译器档的路线约束**（2026-09-27 写进 `ext/r/SPEC.md` 第零节）：
     `ext/r/adapter.js` 里那几千行手写的 `r_*` 辅助函数是"把库塞进语法层"的历史债，
     **不再往里加**；R 的库与运行时正本是 R 自己的 C，而要拿到 `src/main` 那一摊
     （`format.c` 的 `formatReal`、`printutils.c` 的 `EncodeReal0`、`qsort.c` 的
     `R_qsort`、`util.c` 的 `R_strtod` —— 我们手抄那几套规则的地方，正本都在这儿）
     就得先过这道链接器。**也不要改用方言 `.sx` 重写一份 R 的库** —— 那只是把同一份重写
     换个地方存（2026-09-27 试过一小步、当天撤了，账在 `ext/r/SPEC.md` 第零节末尾）。
   * **而那个链接器还要先过一道门**（同一次探底量的）：线性内存那条腿上，
     MIR 把**地址烤成 i64 常量**。一份 `static int arr[4]` 加一条串常量出来是：
     ```
     const k1 i64 65536          ; arr 的地址
     const k3 i64 65552          ; s 这一格的地址
     data @65552 8 bytes 1800010000000000   ; 里头烤着 65560 —— 一条数据重定位
     ```
     两份模块的 data 段各自从 65536 起，合并就得搬其中一份，而搬了之后代码里那些
     `k1`/`k3` 与 data 段里那些指针值都得跟着改 —— **MIR 里没有重定位记录**。
     所以链接器的前置是"让 C 前端在这条腿上发**符号地址**"（新的 MIR 概念 + 数据重定位），
     那是一刀大活，不是这一刀。
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


## 第七格：`setjmp` / `longjmp` 在 JS 腿上发出来了（已落）

这是四道坎里唯一"卡死"的那一格 —— R 的错误/中断机制整个建在这一对上
（`errors.c` 的 `R_ToplevelExec`、`context.c` 的 `RCNTXT` + `R_jumpctxt`、
`Rf_error` → `jump_to_top_ex`）。从前 `emit_js.js` 撞上就抛（`JS_NOJMP`），
理由写的是"发出来的 JS 没有 pc 可以回"。

**那句话只对了一半。** 回不去一条**指令**是真的，但这一份发射器的形状让
"回到某一条指令**之后**"变得可表达：

1. 槽（`s0`…）与 SSA 值（`v0`…）全是**函数作用域**的 `let` —— 帧在 longjmp 之后
   原样在那儿，不需要保存/恢复任何东西；
2. 函数体是**结构化**的（BLOCK/LOOP/IF 落成带标签的 JS 块）—— 所以
   **从函数开头重新走一遍、把沿路的语句跳过去**，就能落到任意一条指令上。

于是落法是（`sjPlan` 算路、`func` 发码）：

* 带 `setjmp` 的函数整个身子套一层 `$RETRY: for(;;) { try { … } catch { … } }`；
* `$rs`（resume site）= "这一趟要回到哪条指令"，0 = 正常从头跑；
* 每一段**不在路上**的语句裹一层 `if ($rs === 0) { … }` —— 导航时整段跳过去；
* 路上的区域照原样开，**IF 的条件换成"`$rs` 指着我这一支吗"**（原来那个条件在导航时
  不重算 —— 它的输入是上一趟算出来的）；
* 到了那条 `setjmp` 调用点，三种情形分开：是回到我这儿的（拿回值、关掉导航）、
  正常跑到（往 `jmp_buf` 上装一次、回 0）、`$rs` 指着**另一个**落点（什么都不做，
  让导航继续）。**少了第三种，同一个函数里第二个 `setjmp` 永远到不了。**

两处要点：

* **调用点在调用方，不在桩里。** C 前端给每个外部符号发一个桩（体里一条 CCALL），
  所以要回去的是调用方那条 `CALL`。按桩里那条 CCALL 的**入口名**认桩，不按函数名认。
* **一趟调用一个记号**（`sjTok()`）：递归时同一个函数在栈上有好几份，
  `longjmp` 抛出来的那个记号决定是哪一份收。
* 不恢复槽 —— 与 `mir/interp.js` 一致（C11 7.13.2.1 只保证 `volatile` 的自动变量），
  两条腿在这一点上一样，"JS 腿 == 解释腿"那道门才站得住。

判据：`tests/c/run.js` 的 `sys/` 组现在也上 JS 腿（5 格，`04-setjmp` 是其中一格）。
那一份用例里特意加了两种形状 —— **落点藏在 then 一支的循环里**、**落点藏在 else
一支里** —— 因为这两种才真正考导航。三条腿（`cc` / 解释 / JS）逐字节相同，退出码 13。

## 第八格：真浏览器里跑同一份 C、画同一张图（已落）

前面几格都在 node 上。这一格把"R 的 C 在浏览器里画图"从**说得通**变成**跑过了**。

三件事凑齐才可能：

1. **`omni c cpp` 把驱动二摊平成一份自足的 `.c`** —— R 那 120 份源码与 SDK 的头全展开，
   **550 365 字节 / 16 195 行，一个 `-I` 都不要**。浏览器那条腿的文件系统是内存里一张表
   （`host/browser.js` 的 VFS），它装不下 r-source，但装得下这一份。
   先证它自足：不给任何 `-I`，画出来的 SVG 与原件**逐字节相同**。
2. **单体 HTML 里那份编译器自带 C 前端**（`tools/bundle-studio.mjs` 把 `src/` 整棵内联）。
3. **`/api/file` PUT 能把一份源码写进那张内存表** —— Studio 自己"存了再跑"就是这条路。

于是判据两层（都在 `tests/r/cjs.js` 最后一节）：

* **node 当壳子那一趟**：把内联的那段 JS 抠出来、前面塞一格 `window`
  （`tests/studio/run.js` 第 3 节同一招）—— 跑的就是页面上要跑的那份代码；
* **真浏览器那一趟**：起一格静态服务，`playwright-cli` 开页面，
  页面自己 `fetch` 那 550 KB 的 C、PUT 进表、`run … --backend js`。
  判两样：**控制台一条错都没有**、**stdout 与本地 JS 腿逐字节相同**（7547 字节的 SVG）。
  没装 `playwright-cli` 就明着跳过。

两处踩到的坑记在这儿：

* `run x.c` 在页面上**必须明说 `--backend js`** —— 缺省是原生那条路（编 + 链 + 跑），
  而页面上没有链接器也没有 libc，报的是 `elf: 找不到库 '-lc'`；
* 静态服务给 `.html` **必须报 `text/html`** —— 报成 `text/plain` 浏览器就把它当源码显示，
  `playwright-cli goto` 直接失败。

**这一格是目标里"要求正常渲染"那句话的落点**：同一份 R 的 C，在页面那份编译器里
编成 JS、跑出来、画出同一张图，而那张图 Studio 的预览栏当图挂（`<svg>` 印到 stdout）。

## 第九格：data 段里的指针**有重定位记录了**（已落，2026-09-27）

这是"第 2 道坎"那道**前置门**的第一半。坎里那句话是：线性内存腿上 MIR 把地址烤成
i64 常量，两份模块的 data 段各自从 64K 起，合并要搬其中一份，而**MIR 里没有重定位记录**。

现在有了一半：**data 段里"这 8 个字节装的是地址"记下来了。**

* `Mir.addData(off, bytes, relocs)` 多收一格 `relocs = [{at, size:8}]`（`at` 是段内偏移），
  越界与宽度不是 8 都当场报（`src/core/mir/ir.js`）；`print.js` 把它印成
  `data @65552 8 bytes 1800010000000000 reloc @0`。
* C 前端那侧新开 `emitPtrBytes(addr, value)`：指针的静态初始化式三条路
  （`char *s = "hi"` / `wchar_t *p = L"ab"` / `int *p = &arr[1]` 那一族）都改走它，
  它照旧写那 8 个字节，**顺手往 `pendingPtr` 记一条**。范围指定初始化器复制字节时
  这张表跟着复制（与 `pendingFix` 同一处）。
* **只记真指进这块 data 段的**（`[64K, dataOff)`）：`static int *p = (int*)4096;`
  那种"整数常量当指针"不是地址，搬的时候一个字节都不该动。这一招与 native 那侧
  `anonFixOf` 按地址区间认匿名静态块是同一招。留下的缝（真写 `(int*)65552` 恰好落在
  区间里）明写在 `emitPtrBytes` 的注释里。
* native 那条腿一个字节不受影响：它有真符号，落的是 `putSymBytes` 那种按符号号的
  `fixups`（`globalBlob`），不走这条。

判据：`tests/c/run.js` 新的 `reloc/` 那 5 格 —— 串的地址 / `&另一个静态量` /
struct 成员里的串各 1 条记录，纯数那份与"整数常量当指针"那份 **0 条**
（把整数错当地址去搬，出来的是一个乱指的指针，所以反面那两格与正面一样重要）。
记录的形状也钉住了：正好 8 字节一段、`reloc @0`。

**另一半（同一天落的）**：代码里那些"其实是地址"的 i64 常量也记下来了 ——
`Mir.addrConsts`（`consts.addr(v)` 造的那些；地址之间照旧去重，只是**不与普通整数共用
一条** —— 去重会让"恰好等于某个地址的普通整数"与地址混成一条，那时"这条是地址吗"
就答不清了，而搬的时候把普通整数也加一个差是静默答错）。C 前端那侧四处取址
（串 / 宽串 / 全局量 / 静态复合字面量）都改走 `kaddr`，指针算术的常量折叠把记号带下去
（`arr + 2` 折出来还是地址）。`print.js` 在那一行末尾印 `addr`。

**于是"搬一个差再跑一遍"成了可判的**：`tests/mir/reloc.js`（6 格，1.3 秒）——
同一份 C 编两遍，一份原样跑、一份照两张表把 data 段整块搬到内存后头再跑，答案必须相同。
最后一格是**反面**：故意不打数据重定位，答案必须变（否则这道门判不出"记录漏了"）。

这道门当场抓出一处**真的隐患**：范围指定初始化器复制 data 段时，复制出来的那几段
与原件**共用同一个字节数组**（`bytes: d.bytes`）。搬 data 段的人是就地改字节的，
共用就会被改两遍 —— `char *g[4] = {[0 ... 1] = "BB"}` 搬完之后第二格指到界外。
改成 `d.bytes.slice()`。这正是"先记录、再照记录搬"这两步分开做的价值：
记录本身的测试（`tests/c/run.js` 的 `reloc/`）看不出这种别名，而"真搬一遍"看得出。

**还差的**：影子栈与堆那几格基址（按 `dataOff` 一路算出来的）不在 `addrConsts` 里 ——
它们不是"加一个差"能对的东西，两份模块并起来时整块布局要重算。那是链接器自己的事。

### 更正（2026-09-27 傍晚）：**两条路都不要"MIR 层的链接器"**

上面那句"到 `src/main` 这一步该做的是 MIR 层的链接器"**是错的**，作废。当天照它做了一版
（`src/core/mir/link.js` + `tests/mir/link.js` + `lang/c.js` 的 `cMirLink`），路线对齐之后
**整个撤掉**。正确的两条路是：

**C 路径**：R 的运行库按 **R 自己那套编译方式**编出来（configure/Makefile，产物是真的库）；
R 程序编到 C；这些 C 与那个库由**我们自己的 C 前端 + 链接器**编链
（`omni c tcc` / `obj` / `link`，那一套已经有 ELF/Mach-O/PE 写出器与链接器），
也可以 `OMNI_CC=cc` 指外部 cc。**多翻译单元的链接是 C 链接器的事，不是 MIR 的事。**

这一条量过了（判据 `tests/c/run.js` 新的 `link2/` 两格）：两份 `.c`，跨单元调函数、
跨单元 `extern` 变量、两份各有一个同名的 file-scope `static` —— 我们自己那台驱动链出来的
退出码与 `cc` **一样**（134 / 139）。也就是说 `src/main` 那 99 份在这条路上要的东西
**本来就有**，缺的是"把 R 的库按它自己的方式编出来"这件工程活，不是一个新的链接器。

**JS 路径**：**一个 `.c` → 一个 `.js` 文件**，JS 模块之间 `import` / `export`
**自动成依赖图** —— 所以也不需要"把多份并成一份"。要做的是另一件事：

* 每份生成的 JS 模块**导出**它定义的函数与数据符号、**导入**它用到的外部符号；
* 那块线性内存由一个 rt 模块提供（大家 `import` 同一块）；
* 每份的 data 段落在哪儿由**加载期**分配（`__alloc(size, align)` 那种），于是
  **地址不能是编译期烤死的常量** —— 这正是今天留下来的四张记录表的用处：
  `mem.data[].relocs`（字节里哪几格是地址）、`addrConsts`（哪几条常量是地址）、
  `dataSyms`（谁提供一个数据符号）、`dataRefs`（谁引用了外部数据符号）。
  把它们从"编译期常量"改成"模块基址 + 偏移"就是 per-file JS 那一刀。

所以下面这一节里"六步 + 判据"那份规格**只对已经作废的那条路**成立，留着当记录。

### 链接器第一刀该怎么落（下一步，2026-09-27 量出来的形状）

两份翻译单元长什么样，量过了。`a.c` 里 `int bee(int);`（声明了、没定义）+ `bee(20)`
落出来是**三样**：

```
cabi c0 bee                                  ; 一条外部 C 符号
func bee(x:i32) -> i32                       ; 一格**桩**：体里就一条 CCALL
  %0 LOAD i32 slot0:x
  %1 CCALL i32 bee (%0)
  %2 RET  i32 %1
func main() -> i32
  %0 CALL i32 bee (k1)                       ; 调用点是**普通 CALL**，按函数表下标
```

所以"链接"这件事在这一层是**把桩换成真定义**，一共六步（前两步这一刀已经有表了）：

1. **搬 B 的 data 段**：`mem.data[].off` / `relocs` 指的那几格 / `addrConsts` 各加一个差
   （`tests/mir/reloc.js` 判的就是这一步够不够）；
2. **页数**取两份的上界，影子栈与堆的基址**重算**（它们不在 `addrConsts` 里，见上）；
3. **常量池接上**：B 的常量追加到 A 的池后头，B 的代码里所有 `ref >= REF_BIAS` 的操作数
   按"旧下标 → 新下标"改写（`addrConsts` 里那几条也跟着改号）；
4. **函数表接上**：`CALL` 的被调方记的是**函数表下标**（`ir.js:259` 的 `a = 函数表下标`），
   所以 B 的代码里每一条 `CALL` 的 `a` 都要按新表改写；
5. **桩换定义**：A 里那些"体只有一条 CCALL、而且 CCALL 的符号就是自己的名字"的函数，
   若 B 里有同名的真定义，就用 B 的那一份顶掉（`cabi` 里那条声明一起摘掉）；
   两边都是真定义 = 重复定义，当场报；两边都只有桩 = 真外部符号，留着。
6. **入口**：留 A 的 `omni_main`，B 的那一格丢掉。

判据（照这棵树的规矩，先写判据）：`tests/mir/link.js` —— `a.c` + `b.c` 各带一条自己的
静态串（`tag = "A"` / `"B"`，于是**两份的 data 段必须都在**、各自的指针各指各的），
`main` 调 `bee`，链完在解释腿上跑出的数必须等于**把两份源码拼成一份编出来**的那个数。
反面一格：不搬 B 的 data 就必须不一样。

`src/main` 那 99 份要的正是这一套（再加"同名 static 函数按文件挂后缀"），
而摊平脚本那条路已经量死在 490 条错上 —— 所以链接器是唯一的路。

### 落了什么（2026-09-27）

`src/core/mir/link.js` + `tests/mir/link.js`（6 格，1.5 秒）：

* **两份链起来跑出的数 == 把两份源码拼成一份编出来的数** —— 尺子选"拼成一份"而不是手写
  期望值，于是这道门同时钉住"链接没改语义"；
* 反面一格：把 B 的两张表清空（= 忘了搬它的 data）答案必须变（抓得住）；
* **同名 `static` 各算一个**（挂 `__lk2` 后缀）—— 记号那一半在 C 前端：`static` / inline
  从前只在 native 腿打 `MirFunc.local`，现在两条腿都打；
* **两份的 C 符号表合并**（按名字建映射、改写每条 `CCALL` 的 `a`）—— 少这一步会指到
  A 表里另一个符号上，**静默调错函数**；
* **三份一起链**（`linkAll` 从左往右折）；
* 重复定义（两边都是非局部的真定义）当场报。

布局是"**每份各占自己那一段线性内存**"（B 的整块像挪到 A 的页数之后）—— 费地址空间，
但省法（并成一段、只留一份栈）与这一版共用同一套判据，下一刀再说。

### 下一道坎：**跨翻译单元的 extern 变量**（量出来了）

```
a.c:  extern int shared;  int main(void){ return shared; }
b.c:  int shared = 7;
→ a.c:2: error: undefined symbol 'shared'       ← 在**编译期**就死了
```

函数那一侧有桩（`cabi` + 一格 CCALL 的身子）可换，**变量那一侧没有**：这条腿上取一个
全局量的地址就是"烤一个数"，而外部变量的地址编译期根本不知道。R 的 `src/main` 里这种
引用遍地都是（`R_NilValue` / `R_GlobalEnv` / `R_print` …），所以这是下一刀。

形状（与 `addrConsts` 那两张表同一条路子）：
* `dataSyms: Map<名字, {addr, size}>` —— 本模块**定义**的非 static 全局量（谁提供）；
* `dataRefs: [{ref, 名字, add}]` —— 代码里那些"其实是外部数据符号地址"的常量，
  值先填 0，链接时按提供方的 `addr + add` 回填（`ref` 指的就是常量池里那一条）；
* data 段里也可能有这种引用（`static int *p = &shared;`）—— 那时 `relocs` 那一条要带上
  符号名，而不只是"加一个差"。
* C 前端那一侧：`extern` 且本 TU 没定义时**不再当场报**，而是发一格"待回填"的地址常量。


## 账

* 122 份 `.c` 摊成 15 641 字节的 `nmath-lib.c`（`#include` + `#define`/`#undef`，
  不含 R 的源码本身），两个驱动各包它一次。
* 改名的 `static`：10 个名字、22 处。
* `node tests/r/cjs.js` 全过（20/20）：66 格数 + 一张 7547 字节的 SVG
  + 两张 480×320 的 PNG（交帧那一档与设备自己的笔那一档，各自两条腿逐字节相同）
  + 摊平预处理那一份 550 365 字节的自足 `.c` 在 **node 壳子与真浏览器**里画同一张图。
* `node tests/c/run.js` 112/0（`sys/` 那 5 格是这一刀新上 JS 腿的）。
* 产物落 `.omni-cache/r-rt/js/`（约定：生成物不进版本库，也不进临时目录）。

## 第十格：JS 路径的第一刀 —— **地址在装载期才定**（已落，2026-09-27）

"一个 .c 一个 .js，依赖自动成图"卡在一件事上：这条腿上**地址是烤成数的**。
`static const char *s = "hi";` 落成 `memData(65544, [104,105,0])` 与 `$ld_i64(65536n, 0)`
—— 那是"整个程序一份 MIR、data 段从 64K 起"才成立的写法。一份 .c 一份 .js 之后，
谁落在哪儿是**装载期**才知道的。

这一刀把那句话改掉（`emit_js.js` 的 `opts.module === true`）：

* 模块顶层一句 `const $B = memAlloc(<整张像的字节数>, 16);`，`$D = $B - 65536` 是"与烤死
  那一版的差"。内存是 rt 那**一块共用的**（`js_rt.js` 的 `memAlloc`：没开张就开一页，
  不够长就 `memGrow`）；
* 每条地址常量落成 `const $k<n> = <原值>n + $Dn;` —— 哪几条是地址由前端记的
  `mir.addrConsts` 说；
* data 段在**装载期**就铺（不再在 `$run()` 里）：`memPut(off + $D, [...], [[at,size]…], $D)`,
  段里装地址的那几格跟着加同一个差 —— 哪几格由 `mem.data[].relocs` 说；
* 这一档**自己不退出**：`export { $run }`，谁是程序入口由上面那一层说。

占的是**整张像**（`[64K, mem.min 页)`）而不只是 data 段：影子栈、堆、argv、errno、
strerror 那几格基址都是按 `dataOff` 一路排出来的，整块搬才对得上。代价写在明处：
**只有最后占坑的那份模块能长堆**（`memGrow` 加的页在内存尾上）—— 真做成 N 份模块时
堆要由 rt/入口那一份最后占，这一格的账下一刀还。

### 这道门抓出的真 bug：`printf("…")` 的串地址丢了"我是地址"的记号

`tests/mir/jsmod.js` 把基址推开 3 页再跑，`str-ptr` 那格的 stdout 是**空的**，退出码却对。
顺着 MIR 看见两条一样的数：

```
const k1  i64  65552 addr      ← strLit 的 kaddr
const k5  i64  65552           ← 真正传给 printf 的那一条，没有 addr
```

`char[7]` 退化成 `const char *` 要过一次 `castTo`，那儿的常量折叠是
`konst(ty, asUintN(...))` —— **把记号扣掉了**。搬完之后 `k5` 还指着搬之前的地方，
那儿是没人写过的零字节，于是 `printf` 拿到一个空串：**静默错答案**，退出码与 stderr
都看不出来。`addrOf` 里 `&st.b` 那一折（`consts.int(k + off)`）是同一个病。
两处都改成"折完还是同一个地址就走 `kaddr`"（值真截断了才按普通整数收）。

`tests/mir/reloc.js` 判不出这一格：它搬的是解释腿，而那一腿上 `printf` 的串照样能读到
——差别只在**发出来的 JS 把地址写成了字面量**。所以这道门是新的。

### 判据（`tests/mir/jsmod.js`，9 格，8.6s）

7 份 C（串指针 / `&arr[2]` / 结构体里的指针 / 范围指定初始化器 / malloc / 取局部量地址 /
strerror），每份都比"烤死版"与"module 版先 import 一个只占内存的垫片（推开 3 页、
再推开 100 字节）"的 **stdout + 退出码**；再加两格反面：抹掉 `relocs`、抹掉 `addrConsts`,
答案必须变（抹掉 relocs 之后是 `|0` 而不是 `hi|105`，抹掉 addrConsts 之后是空串）。

stdout 落**文件**而不是管子：被 `import` 进来的模块里调 `process.exit()` 会把还挂在管子上
的那几笔写丢掉。那是宿主的收摊次序，不是这条腿的事 —— 但判据要可比，所以两边都落文件。

## 第十一格：符号靠 `import`/`export` 接上 —— 依赖图就是 ESM 的依赖图（已落，2026-09-27）

第十格把地址挪活了，这一格把**符号**接上。一份 .c 一份 .js 之后要答三个问题：
谁定义了这个名字、引用方怎么写、谁排装载次序。答案分别是**前端记的表**、
**`import`**、**ESM 自己**。

### 前端这边（`tccgen.js`）

* `lowerC(..., { tu: true })` —— **一份 .c 一份产物**那一档：
  * `main` 不是必须的（没有就只发"序"：`$sp` 的初值、errno/strerror/流那几格 + `RET 0`）；
  * **堆不烤进像里**（记一条 `mod.wantsHeap`）—— 堆靠 `MGROW` 往内存尾上长，而 N 份
    模块各占一段之后"谁在尾上"要等全部装载完才知道。所以改成入口跑起来时由运行时在
    尾上要一页（`js_rt.js` 的 `memHeap`，幂等）。这一格的账从前写在第十格的"下一刀"里，
    现在还了。
* `MirFunc.thunk = 名字` —— **这个身子只是转发桩**。线性内存腿上外部函数一律有桩
  （落点是 `CCALL name`），所以"这个名字是我定义的还是别人提供的"光看有没有函数体
  分不出来；这一条就是那个分界。
* `mod.dataRefs` 记的不再只是基址那一条，而是**那块预留地方里的每一条地址常量**
  （`{name, ref, add}`）：`&arr[2]` 与 `arr + 1` 会在 `castTo`/`ptrAdd` 里折成新的常量。
  只记基址的话，折出来的那几条在装载期还指着本模块预留的那块空白 —— 静默答错。
* data 段里指进外部符号的那几格（`static int *p = &arr[2];`）现在带符号名：
  `relocs` 那一条多两格 `{sym, add}`。它不是"加一个差"能对的，要等提供方的地址。

### 发代码这边（`emit_js.js` 的 `opts.symbols`）

`symbols` 是一张 `名字 -> 提供它的那份模块的 specifier` —— 函数与数据**同一张表**
（C 的符号表就是一张）。于是：

* 桩的名字在表里 → 不发桩的身子，`import { $fn_add as $f0 } from './b.js'`；
* `dataRefs` 那几条常量 → `$sym_base`（带偏移的发成 `($sym_arr + 8n)`）；
* data 段里带 `sym` 的那几格 → `memPut(..., [[at, $sym_arr + 8n]])`（写死，不是加差）；
  表里找不到提供方就**当场抛**（成品那一层报 undefined symbol）——
  悄悄按"加一个差"铺下去就是静默答错；
* 自己那一侧：`export { $f3 as $fn_add }`（真定义、非 static）与
  `export const $sym_base = <地址>n + $Dn`（导出**地址**，C 那边它就是一块内存）；
* 没有 `main` 的模块导出 `$init()`（只跑"序"，不收退出码、不 `libcAtExit` ——
  收摊是程序的事，不是库的事），有 `main` 的导出 `$run()`。

活绑定省掉了一层：函数与地址都在**函数体里**才用到，那时所有模块都装载完了，
所以有环也不怕。唯一还怕环的是 data 段里那几格 `$sym_x`（装载期就要读）——
真成环时是一条 TDZ 报错，响的，不是静默。

### 判据（`tests/mir/jsmod.js` 又五格，14/0 共 9.6s）

五份多模块的程序，每份都是"一个 .c 一份 MIR 一份 .js + 一个入口文件"：
跨模块调函数、跨模块读 `extern int` 与 `extern int[]`、`&arr[2]` 折出来的那一条、
两份模块各有一个同名 `static`（互不相干）、三份链成一条（a→b→c，各自的 data 段谁也不踩谁）。

## 第十二格：nmath 那 122 份**不再摊成一份**（已落，2026-09-27）

`ext/r/cjs/gen.js` 头上那句"要么写一个 MIR 层的链接器，要么摊进一份 `.c`"现在有第三条路，
而且走通了：**一个 .c 一个 .js，符号靠 `import`/`export` 接上**。

* `src/core/lang/c.js` 的 `cJsModules(units, opts)` —— 三步与真链接器一一对应：
  每份单独编（`tu` 档）、算符号表（谁定义了哪个名字）、发代码（把**别人**提供的那些
  当 `opts.symbols` 交给 `emitMirJs`）。`cJsEntry` 出那个入口文件。
* 两条"什么才算定义"的规矩是**量出来的**，不是想出来的：
  * **只声明、一条指令都没有的不算**（`f.count() === 0`）：系统头一份 `<math.h>` 带进
    上百个这样的名字（`__math_errhandling` / `acosf` / …），认它们是定义的话两份模块
    一碰就是假的 `duplicate symbol`；
  * **块里的 `static` 不算**（`e.isStatic`）：`fprec` 里那个 `static double max10e;`
    的登记名是 `fprec.max10e.0` —— 它连合法的 JS 标识符都不是，导出去当场是语法错。
    （这一格的症状正是 `export const $sym_fprec.max10e.0 = …`。）

### 账

* `node ext/r/cjs/gen.js` 多写一份 `mod/probe-drv.c`：与摊平那个驱动**同一个 `main`**，
  只换了头（那份 `#include` 摊平的 `.c`，这份只 `#include <Rmath.h>` 按原型调）。
* 123 份 `.c` -> 123 份 `.js`，6 173 563 字节，对外符号 195 个，编 + 连 **3.8s**。
* `node tests/r/cjs.js` **22/0**（新增两格）：最后那格判的是
  **"一份一份" 与 "摊成一份" 的 stdout 逐字节相同**（66 格数 + RNG）。
  小判据（`tests/mir/jsmod.js`）判形状，这一格判量 —— 122 份真源码上那两张记录表够不够用。
* `node tests/c/run.js` 120/0 不动。

### 还没还的账（写在明处）

* **堆只有一份**：`memHeap()` 在内存尾上要一页，幂等 —— 但它要求"所有模块的 `memAlloc`
  都走完了"，靠的是"data 段在装载期铺、堆在 `$run()` 里要"这个次序。真出现"库在装载期就
  malloc"时这条会绷断，那时堆要挪出模块的像、由 rt 统一管。
* **data 段里的跨模块指针怕环**：那几格 `$sym_x` 是装载期就要读的，所以两份模块在 data
  段上互指时会撞 TDZ（响的，不是静默）。真撞上要把那几格挪进一个 `$link()`。
* 变参的外部函数还不能跨模块 import（桩的签名是"固定形参 + 变参区指针"，
  而那一档的调用点早就直接 `CCALL` 了）—— nmath 里没有这种，R 的 `src/main` 里有。

## 第十三格：`_Complex` 当布局收下 —— R 运行时 0/111 变 90/111（已落，2026-09-27）

不停在 nmath。`src/main`（99 份）+ `src/appl` + `src/unix` 一份一份过我们自己的 C 前端
（`tu` 档），扫出来的第一张表是**一类错占了 107 份**：

```
/…/src/include/R_ext/Complex.h:81: error: identifier expected     107 份
```

那一行是

```c
typedef union { struct { double r; double i; }; double _Complex private_data_c; } Rcomplex;
```

—— R 几乎每份 `.c` 都经过它。而那一格**从来没人算它**（R 自己的 C 用 `.r` / `.i`），
它在那儿只是让想用 C99 复数的外部代码能别名同一块内存。所以这一刀只补"多大"：

* `_Complex` 落成一个**两格同类型浮点的匿名 struct**（`complexType`，一个翻译单元一份
  —— `sameType` 比的是引用，两处各建一份的话同一种复数会成为两个类型）。于是 `sizeof`、
  对齐、按值拷贝、放进别的 struct、取地址、数组全都白捡，后端一行不改。
* **算术不收**：`a * b` 落在这个类型上报的是"struct 当值用还没到" —— 响的，不是静默错。
  真的复数算术是另一刀（`src/main/complex.c` 要它）。

### 账

* `tests/r/rtc.js`（新轴）：**90/111 份编得过**，共 180 839 个函数。判据是一个**地板**
  （只许涨）；剩下 21 份按类印出来，就是下一刀的选题单：
  * 9 份 外部函数**返回** struct 要真 ABI（线性内存腿）
  * 4 份 外部函数**按值收** struct 同上
  * 2 份 `constant expression expected`、2 份 `incompatible types for redefinition`
  * 各 1 份：`cannot convert`、`invalid number`、`计算跳转却没摆状态机`、一个找不到的头
* `tests/c/gen/87-complex-layout.c`（新格）：大小 / 对齐 / 数组 / 别名 / 按值拷贝 /
  嵌进 struct 的偏移，**退出码与 cc 逐字节相同**（196）。
* 顺带掉出一个真 bug：`structLayout` 的成员记录少 `aligned`/`packed` 两格时算出 `NaN`
  尺寸，`sizeof` 那条路当场抛 `RangeError` —— 自己造成员表时那两格必须给。

## 第十四格：按值收发 struct 的外部函数**不发桩、等链接** —— 90/111 变 103/111（已落）

第十三格之后剩下 21 份，头两类占了 13 份：

```
9 份  外部函数 'ALTCOMPLEX_ELT' 返回 struct 还没到（要真的 ABI）
4 份  外部函数按值收 struct 还没到（要真的 ABI）
```

看名字就知道这条错**归错了类**：`ALTCOMPLEX_ELT`（回 `Rcomplex`）、
`R_findVarLocInFrame`（回 `R_varloc_t`）不是 libc，是**R 自己另一份 `.c` 里的函数**。
"转不了手给宿主"这句话只对 libc 成立 —— 桩的身子是"读进形参、发一条 CCALL 转给宿主"，
而我们的 struct 躺在自家线性内存里，宿主按真 ABI 读寄存器，所以那条路确实走不通。

但在**一份 .c 一份 .js** 那条路上根本不必走那条路：

* `tu` 档里遇到"按值收发 struct 的外部函数"时**不发身子**（`f.setExtern()` + `f.setThunk(name)`）；
* 调用点照旧按**我们自己的** ABI 发 `CALL`（与模块内调用一模一样）；
* 谁提供它由符号表说（`cJsModules`）。没人提供就是 `undefined symbol` ——
  发一个空身子出去才是静默答错（调它什么都不做、回 `undefined`），所以那一格
  在 `emit_js` 与 `cJsModules` 两处都当场抛。

代价写在明处：真的 libc 里按值收发 struct 的那几个（`div` / `ldiv`）现在从"编译期硬错"
变成"链接期 undefined symbol" —— 同一件事晚一步报，而且多了一条出路：
用 C 自己写一份 `div` 编进模块集里就补上了。

### 账

* `tests/r/rtc.js`：**103/111**（地板抬到 103）。剩下 8 份 8 类，都是单点：
  `Rstrptime.h` 里两处 `constant expression expected`、hershey 字库两处
  `incompatible types for redefinition`、`complex.c` 的 `1.0iF` 虚数字面量、
  `array.c` 一处把复数当整数用、`eval.c` 的计算跳转、`memory.c` 要 `stdalign.h`。
* `tests/mir/jsmod.js` 新增一格 `struct-byval-across`：两份模块之间**按值传/按值回**
  一个 `{double r; double i;}`，`(1.5+2i)(0.5-1i) = 2.75-0.5i`，退出码与输出都对上。

## 第十五格：三个单点 —— R 运行时 103/111 变 108/111（已落，2026-09-27）

剩下那几类都是单点，一刀一个：

1. **宽字符常量进不了常量表达式**（2 份）：`case L'%':` 报 `constant expression expected`。
   `ceUnary` 只认 `TOK_CCHAR`，漏了 `TOK_LCHAR` —— 而 C11 6.4.4.4 第 11 段说宽字符常量
   也是整型常量（类型 `wchar_t`）。R 的 `Rstrptime.h` 与 `printutils.c` 里满地都是。
2. **`<stdalign.h>` 不在搜索路径上**（1 份）：系统那份在 clang 的资源目录里
   （`/…/lib/clang/17/include`），不是 SDK 的 `usr/include`。自带一份（四个宏，
   真东西是早就认的 `_Alignas` / `_Alignof` 两个关键字）比去猜 clang 的版本目录稳。
3. **`extern T x[];` 那一对**（2 份 + 顺带 35 份）：从前不带长度的 `extern` 数组按
   **0 个元素**登记，于是"头里声明、`.c` 里定义"那一对（R 的 `g_extern.h` +
   `g_fontdb.c`）成了"长度 0 与长度 N 冲突"。现在：
   * `mergeTentative` 认"长度不知道"（`unsized`）：另一条写了长度就算另一条的；
   * 长度补上时**重划地方** —— 占位块是 0 字节，不重划就与后面那个全局量叠在同一个
     地址上（静默答错）。已经有人取过它的地址就来不及了，那时报出来；
   * 反过来那 35 份（`extern T x[];` 用了、但**这个单元里没有定义**）从前一律报
     `unknown type size`。那种用法只要"基址 + 下标 × 元素大小"，长度一个字节都用不到
     （`sys_errlist[i]` 就是），所以给它划一格 8 字节的**占位**，真地址由链接那一步
     按符号名回填（`mod.dataRefs`）。

### 账

* `tests/r/rtc.js`：**108/111**（地板抬到 108）。剩下 3 份要的是复数**算术**
  （`complex.c` 的 `1.0iF`、`array.c` 的 `cimag(x*y)`）与**计算跳转**（`eval.c` 的
  bytecode 解释器，`&&label`）—— 那是两把更大的刀。
* `tests/c/gen/88-extern-array-bound.c`（新格）：声明在前、定义在后的四对
  （`int[]` / `const char[]` / `double[]` / `struct[]`），中间夹两个哨兵全局量
  判"没被叠在一起"，退出码与 cc 逐字节相同（102）。
* 一个已知的洞写在明处：占位块上**折出来的内部地址**（`&x[2]`，x 是长度不知道的
  extern 数组）认不回符号 —— R 里没有这种写法，真撞上要在常量折叠那一处按名字记。

## 下一刀：复数**算术**（形状量出来了，2026-09-27）

`tests/r/rtc.js` 剩下的 3 份里有 2 份要它（`complex.c`、`array.c`），而 R 的复数运算
**就是 C99 的运算符**（`src/main/complex.c` 的 TIMESOP / DIVOP 写的是
`SET_C99_COMPLEX(pans, i, toC99(&ps1[i1]) * toC99(&ps2[i2]))`）—— 所以这一格不能"差不多对"。

### 量出来的需求

* 运算符：`+ - * /` 与一元 `-`；`creal` 22 处、`cimag` 19 处（`src/main` + `src/appl`）；
  `clog` 4、`catan`/`casin` 各 3、`ctan`/`csin`/`cexp`/`ccos`/`cacos`/`cabs` 各 2，
  `csqrt`/`cpow`/`carg`/`csinh`/`ccosh`/`ctanh` 各 1。
* 虚数字面量：`complex.c:138` 的 `1.0iF`（`invalid number` 就是这一条）。

### 形状（分两半，与"运行时是 R 的 C + 我们自己编"这条路一致）

1. **前端**（`tccgen.js`）：复数值就是那个两格的 struct（第十三格已经有了），
   所以算术落成"分量算术 + 一个帧上的临时"——`sMem(cty, this.fpRef, this.frameAlloc(cty,0,0))`
   与 `ARGSRET` 那条路数一样，成员按 `sMem(fld.ty, base.mem.addr, base.mem.off + fld.off)` 取。
   `+ - 一元-` 是逐分量的，**精确**，没有边角。
2. **`*` 与 `/` 不许在前端手写朴素公式**：朴素式在 Inf/NaN 上与 clang 不一样
   （clang 发的是 `__muldc3` / `__divdc3`，那两个有 Smith 算法 + Inf 回收），
   而 R 的复数算术明着按 C99 走 —— 手写就是**静默答错**的边角。
   所以 `*` / `/` 落成对 `__muldc3` / `__divdc3` 的 `CALL`，那两个函数
   **用 C 自己写**（`ext/r/rt/omni_complex.c`，照 compiler-rt 的算法），
   连同 `clog`/`csqrt`/… 那 17 个一起 —— 它们内部用 `union { double _Complex z; struct { double re, im; } p; }`
   取分量，所以**不需要复数算术就能写出来**（这也是为什么这一半能先落）。
   单文件那条路（`omni c run x.c`）上这几个名字会是 `undefined symbol` —— 响的，
   要用就把那份 `.c` 一起编进去。
3. 虚数字面量：词法上给浮点常量认 `i`/`I`/`j`/`J` 后缀，值进虚部。

判据：`tests/c/gen/` 加一格与 cc 比退出码（含 Inf/NaN 的几个边角），
`tests/r/rtc.js` 的地板从 108 抬到 110。

### 第 2 半先落了：`ext/r/rt/omni_complex.c`（已落，2026-09-27）

`__muldc3` / `__divdc3` / `creal` / `cimag` / `conj` / `cabs` / `carg` 用 C 自己写完了，
**而且不需要复数算术就能编**：分量靠 `union { double _Complex z; struct { double r, i; } p; }`
取，于是只用到"`_Complex` 有多大"（第十三格）、struct 按值传/回、成员访问三件事。
`isnan`/`isinf`/`isfinite`/`fabs`/`copysign`/`scalbn` 也在这份里自己写 —— 前四个在真 C 里
是**宏**（按函数声明两边都链不上），`copysign` 要的是符号位（走 64 位整数的 union），
`scalbn` 只在除法里缩放（乘 2 的幂是精确的）。

判据在 `tests/r/rtc.js` 第二节：与 **clang 编同两份文件**的 stdout **9 行逐字节相同**，
含 `(Inf+0i)*(2+0i)`、`(Inf+0i)/(2+0i)`、`(1+1i)/0`、`(1e300+1e300i)/(1e300+1e300i)`
那几个 Inf/NaN 与溢出的边角 —— 那正是朴素公式会静默答错的地方。

clang 那边要 `-ffp-contract=off`：它默认把 `a*c + b*d` 收成一条 FMA，最后几位与我们这条
（分开的乘加）不一样（量出来 `big-div` 的虚部是 `-7.8e-18` 对 `0`）。这一格判的是**算法**，
不是"谁的 FMA" —— 真要判 FMA 那是另一格（MIR 上还没有 FMA 这条指令）。

于是下一刀只剩**前端那一半**：`+ - 一元-` 逐分量、`*` / `/` 发成对这两个函数的 `CALL`、
虚数字面量。那 10 个超越函数（`clog`/`csqrt`/…）照同一个套路往这份 `.c` 里加。

## 第十六格：复数**算术**（前端那一半，已落，2026-09-27）—— 110/111

第十五格之后剩下的 3 份里有 2 份要复数算术。落法与那一刀写的形状一致：

* **值就是那块两格的临时**：`cplxTemp` 在帧上划一块（与 struct 返回值的 `ARGSRET`
  同一条路数），分量按 `sMem(fld.ty, base.mem.addr, base.mem.off + fld.off)` 取。
  于是复数表达式的结果是一个**左值**，`.r`/`.i` 与 `__real__`/`__imag__` 都能直接落到它上头。
* `+` / `-` / 一元 `-`：逐分量，精确，没有边角。
* `*` / `/`：发成对 `__muldc3` / `__divdc3` 的 `CALL`（`cplxCall` 顺手把那两个名字
  当外部函数登记进去）—— 身子在 `ext/r/rt/omni_complex.c`，与 clang 发的是同一个东西。
* `==` / `!=`：两个分量都相等才算（C11 6.5.9 第 3 段），落成两条比较 + 一次 `BAND`。
* 转换（C11 6.3.1.6 / 6.3.1.7）在 `castTo` 的最前面：转成复数补 0 虚部、复数转实数
  丢虚部；赋值那一侧在 `structCopy` 里先转一次（`Z = R_pow(0.0, yr);` 就是这一条）。
* **虚数字面量** `1.0i` / `1.0iF`：`parseNumber` 把值包成 `{im: …}`，记号号仍是那个浮点
  记号。为什么不挂一位标记在 Cpp 上 —— 函数体那两遍是把**记号流**收起来再放一遍的
  （`TokStr` 只带 `tok` 与 `val`），挂在 Cpp 上的一位过不了那一关（量出来的：`1.0i`
  在第二遍里成了普通 double）。常量表达式里遇到它**报错**，不 `Number({…})` 得 NaN。
* `__real__` / `__imag__`（GNU）：进关键字表，回的是那个分量的**左值** ——
  R 的 `Rcomplex.h` 里 `__real__ ans = x->r;` 靠这条造复数。
* `_Complex double z = (double _Complex)3.25;` 里那对括号是**类型转换**不是复合字面量，
  所以初始化那一路上复数要绕开 `isStruct` 那道闸。

### 账

* `tests/r/rtc.js`：**110/111**（地板抬到 110）。只剩 `eval.c` 一份 ——
  它要**计算跳转**（`&&label`，R 的字节码解释器），那是另一把刀。
* `tests/c/gen/89-complex-arith.c`（新格，17 条）：加减、一元负、虚数字面量、
  实数与复数互转、赋值、`__real__`/`__imag__` 当左值、`==`/`!=`、混着实数算、`sizeof`
  —— 退出码与 cc 逐字节相同（151）。`*` 与 `/` 不在这一格（要链运行时），它们的判据
  在 `tests/r/rtc.js` 第二节（与 clang 比十行，含 Inf/NaN）。
* 顺带修了 `tests/c/run.js` 的 `link2` 一格**缓存不自洽**：它要的是 `c tcc` 的副作用
  （落在 `workDir` 里的可执行文件），而缓存只记 stdout 与退出码、`workDir` 每趟先清空
  —— 于是第二趟"退出码 0、文件不在"，`spawnSync` 回 null。那一步改成不过缓存。

## 第十七格：语句表达式里的计算跳转（已落，2026-09-28）—— 111/111，全份编得过

最后那一份 `src/main/eval.c` 报的是 `error: internal: 计算跳转却没摆状态机`。
一开始怀疑 pass1 没数到宏展开出来的标签 —— 不是，标签一个不少。真正的形状是 R 跳
一步那个宏：

```c
#define NEXT() (__extension__ ({currentpc = pc; goto *(*pc++).v;}))
#define BEGIN_MACHINE  NEXT(); init: { int which = 0; loop: switch(which++)
```

`goto *` 写在一个**语句表达式**里，标签（`op_##name`）却在**函数**那一层上。
而 `stmtExpr` 从前一律 `this.gotoSlot = -1`：进语句表达式就把状态槽清空，于是里头
那条 `goto *` 找不到状态机可写。

改法一行：**自己没有标签的语句表达式接着用外面那台**。

```js
this.gotoSlot = labeled ? -1 : outerSlot;
```

* 自己有标签（`({ ... here: ... })`）→ 照旧摆自己的（`-1` 再 `temp(T_I32,'state')`），
  里头的 `goto` 说的是自己那几个标签。
* 自己没有标签 → 里头的 `goto` / `goto *p` 说的只可能是**外面**的标签，
  于是写外面那个槽、`BR` 回外面那圈 `gotoloop`（`levelOf('gotoloop')` 自己这层没开，
  自然找到外面那圈）。

### 账

* `tests/r/rtc.js`：**111/111**（地板抬到 111，227093 个函数）。R 的运行时 —— 除解释器
  那一份 R 代码以外的全部 C —— 走我们自己的 C 前端全份编得过。
* `tests/c/gen/90-se-computed-goto.c`（新格）：`NEXT()` 同一形状的跳转表（语句表达式里
  `goto *`、标签在函数那层）、语句表达式**自己有**标签那一路、外圈 `goto` 套里圈语句
  表达式各摆一台 —— 退出码与 cc 逐字节相同（36）。
* 跑过的门：`tests/mir/run.js` 51/51、`tests/mir/jsmod.js` 15/15、`tests/selfc/run.js` 6/6、
  `tests/r/cjs.js` 22/22（含真浏览器那两格）、`npm run check:self`、`tests/c/run.js gen`。

### 下一刀

编得过之后是**链得起、跑得动**：把这 111 份连成一套（libR 的整张符号表），
非纯计算那一块（图形 / 设备 / 文件系统）按路线做功能映射，再把整套搬进浏览器。

## 第十八格：从"编得过"到"链得起"（已落，2026-09-28）

全份编得过之后，下一问是**这一套能不能连成一个**。这一格不跑产物，只把符号表建起来
把缺口量出来 —— 判据在 `tests/r/rtc.js` 第二节（`node tests/r/rtc.js rt`）。

### 建表：248 份 + 我们自己那两份

进表的是"R 的全部 C，除解释器那一份 R 代码"：`src/main`(99) + `src/appl` + `src/unix`
+ `src/nmath`(123) + `src/extra` 的 `tre` / `xdr` / `tzone`，再加我们自己的
`ext/r/rt/omni_complex.c` 与 `ext/r/rt/omni_libc.c` —— **250 份、对外符号 2552 个、
重名 0**。

缺口分三类，这个分法是**能不能静默答错**决定的：

* **硬缺·数据 3 个**（`__mb_cur_max` / `_libiconv_version` / `mach_task_self_`）：
  data 段引用了谁也没定义的名字。这类不能转手给宿主 —— 放过去就是一个指着自己那块
  空白的指针。（`R_tzname` 原来也在这儿，`tzone` 一进表就有人定义了。）
* **硬缺·桩 0 个**：按值收发 struct 的外部函数（`tu` 档不发身子）。原来 20 个 ——
  复数那 19 个 + `div`，这一格全接上了（见下）。
* **软缺 205 个**：真发了 `CCALL`（口径是 `mir.cabi`，光声明没调的不算）而我们的 libc
  也没有的。按族看：BLAS/LAPACK 的 `d*_`（Fortran，另一条腿）、zlib、iconv、
  pthread/Mach、`xdr_*` 的一部分、`_NSGet*` 那几个 —— **这张表就是功能映射的工单**。

天花板（重名 0 / 硬缺 3 / 硬缺桩 0 / 软缺 205）只许降，地板（对外符号 2552）只许涨。

### 复数超越那一族：13 个 + `div`

`ext/r/rt/omni_complex.c` 从 7 个长到 20 个：`cexp` / `clog` / `csqrt` / `cpow` /
`csin` / `ccos` / `ctan` / `csinh` / `ccosh` / `ctanh` / `casin` / `cacos` / `catan`。
写法上只用"分量出入"（那个 union）与 `__muldc3` / `__divdc3`，公式在这一层，实函数问 libm。

判据与 `__muldc3` 那一格**有意不同**：那两个是"与 clang 链进去的那份逐字节相同"，
这 13 个做不到逐位相同（Apple 的 libm 与任何公开实现都差最后几位），所以判
**相对误差 <= 4e-16（约 2 ulp）** + **分类相同**，156 格（13 × 12 个点），
最大 3.97e-16。尺子那条腿**只编驱动、链 libm**，不链我们那份 `.c` —— 不然是空对空。

量出来两个真错（都是精度，不是语义）：

* `catan` 的符号：`atan z = (1/2i) log(…)`，我写成了 `(i/2) log(…)` —— 差一个负号，
  两个分量全反。判据一跑就抓住（相对差 2.0）。
* `casin` / `cacos` 在 |z| 大时差 2e-13：`iz + sqrt(1-z²)` 两个分量都在互相抵消。
  修法用一个恒等式而不是加位数 —— 两个根的积恒为 1（`(iz+s)(s-iz) = 1`），
  所以 `log(iz+s) = -log(s-iz)`，两者取模大的那一个算，抵消就没了。
  |z| 很小那一带（1e-8 量出来差 5e-9）走级数 `z ± z³/3,6`。

`div` / `ldiv` / `lldiv` 落在新的 `ext/r/rt/omni_libc.c`：它们按值回 struct，
过不了宿主那扇只走标量的门，所以必须由我们提供。顺手判了"跨模块按值回 struct"
（`tests/r/rtc.js` 第一节那 10 行里最后一行）。

### 顺手加的一格

`tests/r/rtc.js` 现在收一个节名：`rt` / `cx` / `cx2`。改一行复数公式要重编 248 份
（55 秒）这件事本身就是个性能问题 —— `node tests/r/rtc.js cx2` 是 1.2 秒。

## 第十九格：全部运行时发成 JS 并**真跑**（已落，2026-09-28）

`tests/r/rtc.js jsrun`（62 秒）：250 份 `.c` -> **250 份 `.mjs`、55 165 054 字节、
对外符号 2555 个**，一遍 `$init()` 全跑过，再按原型调 10 个纯函数 ——
答案与 `Rscript` 的相对差都 <= 1e-12。这是"R 的运行时（除解释器那一份 R 代码）
在 JS 上跑起来"的第一个完整判据。

### 量出来的一个真错：R 的全局要先初始化，不然**静默答错**

`pgamma(2,3,1)` 头一趟答 **1**（R 是 0.3233）。不是我们编错 —— libR 档下
`nmath.h` 里 `ML_POSINF` 展开成 `R_PosInf`，那是 `arithmetic.c` 里一个**运行时
初始化**的全局（`InitArithmetic()` 里才写值）。没叫那一句它是 0，于是
`R_P_bounds_01(x, 0., ML_POSINF)` 看到 `x >= 0` 就回 `R_DT_1` = 1。

这条缝的形状值得记：**standalone 档（`MATHLIB_STANDALONE`）里 `ML_POSINF` 是
`1.0/0.0` 那个字面量，libR 档里是个变量** —— `tests/r/cjs.js` 那 66 格一直是绿的，
因为它走的是 standalone 档。所以判据里现在明着叫一句 `Rf_InitArithmetic()`：
R 自己的 `Rf_initialize_R` 也是这个次序。

### 另一格：漏叫 `$init()` 的报错很难看

只 `import` 一份模块的函数、没叫它的 `$init()` 就调，得到的是
`TypeError: Cannot mix BigInt and other types`（`$sp` 还是 0 不是 0n）。
这不是错答案，但错得不像话 —— 记在这儿：**装载这一套的规矩是"每份都要 $init()"**。
（起一个 `$loadAll()` 的活留给 CLI 那一刀。）

### 账

* 手上这一套：`.omni-cache/r-rt/jsall/` 250 份 `.mjs` + `$judge.mjs`（判据自己写的入口）。
* 还没跑的：R 的**解释器**那一层（`Rf_initialize_R` / `SETUP_MAIN` 要文件系统、
  locale、setjmp 那一整套），与浏览器里那一趟（55 MB 要先打包）。
* 软缺 205 个仍挂着 —— 纯计算那一路上没碰到它们（10 个函数一个都没落到宿主的缺口上）。
* 那个"`InitNames` 卡住"**不是我们的错，是次序错**（当天追出来的，记下来省得再踩）：
  R 的 `setup_Rmainloop`（main.c 984-999）里 `InitStringHash` **必须**在 `InitNames`
  之前、`InitNames` 必须在 `InitBaseEnv` 之后。少了 `InitStringHash` 那一步，
  `type2char` 拿到还空着的 `Type2Table` 就去 `warning`，`warning` 又去 `install`，
  而符号表那一圈这时还没铺好 —— `install` 就在 `strcmp` 上转圈。**卡死不是报错**，
  这是这一族缝的共同形状。照 R 自己的次序叫，`InitNames` 956ms 就过了。
* 顺带量到的一项性能账：250 份 `.mjs` 的 `import` 要 **29 秒**（55 MB 的解析）。
  浏览器那一趟之前这一项得压下去 —— 打成一份包，或按需装载。

## 第二十格：照 R 自己的次序把 libR 初始化起来（已落，2026-09-28）

`tests/r/rtc.js jsrun` 长出第二半：250 份装载之后，照 `setup_Rmainloop` 的次序
叫 R 的 12 步初始化，再用 **R 自己的 API** 兜几个 SEXP 回来。量出来：

* 过了 **11/12** 步：`InitArithmetic` / `InitMemory`(292ms) / `InitStringHash`(161ms) /
  `InitBaseEnv` / `InitNames`(956ms) / `InitGlobalEnv` / `InitOptions` / `InitGraphics` /
  `InitTypeTables` / `InitS3DefaultTypes` / `R_InitConditions`。
* 欠的一步：`InitTempDir` —— 要 `stat`，我们的 libc 还没有（`InitEd` 要 `getpid`，
  同一类）。这两笔在天花板里记着，不静默跳过。
* SEXP 那一层（全走 R 自己的 API，不读内存）：`str2type(type2char(REALSXP))==14`、
  `…(VECSXP)==19`、`asReal(ScalarReal(3.5))==3.5`、`asInteger(ScalarInteger(7))==7`、
  `xlength(allocVector(REALSXP,5))==5`，外加 **`R_gc()` 跑得过**。

也就是说：**R 的类型表、符号表、字符串缓存、全局环境、垃圾回收，在 JS 上都起来了**。
再往前是 `R_ParseVector` + `Rf_eval`（两个符号都在），那要连上 connections 与
`setjmp` 那一套 —— 下一刀。

### 次序错的形状值得单记

它不报错，它**卡死**。`type2char` 看空表 -> `warning` -> `install` -> 符号表还空着 ->
`strcmp` 上转圈。查法也记下来：`node --prof` 跑一趟被 `timeout` 砍掉的进程，
`--prof-process` 的 bottom-up 里 `strcmp` 占 43%，往上三层就是
`type2char -> warning -> warningcall -> install`。

## 第二十一格：R 在 JS 上**真跑起来了**（已落，2026-09-28）

`tests/r/rtc.js jsrun`：251 份 `.mjs` 装上、照 R 自己的次序初始化、然后

```
omni_eval1("1+1")        -> 2
omni_eval1("sum(1:10)")  -> 55        （两格都与 Rscript 一致）
```

也就是说 **R 的分析器 + 求值器 + 内置函数表 + 垃圾回收，在 JS 上都在转**。
路上四个真错，都不是"再补一个函数"那种，值得各记一笔。

### 1. 跨模块的函数指针（前一个提交）

R 的 `R_FunTab`：表在 `names.c`、`do_*` 在几十份别的 `.c`、读表并调的是 `eval.c`。
函数指针的值从前是"本模块函数号 + 1"，跨模块就是**静默调错函数**。
现在值是全程序那张表的槽位（`js_rt.js` 的 `fnSlot`/`fnBind`/`fnCall`）。

### 2. 宿主那一层：`ext/r/rt/omni_rhost.c`（新）

两样东西不是编译器的事，是**宿主**的事，`Rf_initialize_R` 本来管它们：

* **控制台那几格**（`ptr_R_WriteConsole` 一族）：不摆就是
  `call of a null function pointer`（printutils -> system 那一跳）。现在打到 stdout。
* **顶层上下文**（`R_Toplevel` + `R_GlobalContext`，照 `main.c` 984-999 抄）：
  R 出错要沿上下文链往上跳，没有它**在空链上转圈**（量出来：`eval` 一去不回）。

求值走 `R_tryEval` 而不是 `Rf_eval`：它自己摆 `SETJMP` 的上下文，R 里的错误回到我们
手上。不这么做那一格量出来是 `longjmp: 这个 jmp_buf 没有被 setjmp 装过`。

### 3. `InitParser` 也在次序里

少了它，`R_ParseVector` 会在 `SET_VECTOR_ELT() ... not a 'NULL'` 上报错 ——
这句话是**R 自己印出来的**（控制台那几格一摆好就看见了）。
`setup_Rmainloop` 里它紧跟在 `InitNames` 后头，名字没有 `Rf_` 前缀。

### 4. 两个 libc 的缺口：`strcasecmp` / `strncasecmp`

R 的语法分析器认关键字要它们。补在 `src/core/interp/libc.js`（只折 ASCII 的 A-Z ——
这条腿上 locale 是 C）。软缺那张表于是 205 变 **203**。

### 账与速度

* 判据现在 **39 秒**一趟（曾经 62 秒）：发射那一半**按 key 缓存**（源 + 编译器那几份源的
  mtime/size），符号表落 `.syms.json`（探针只编自己那一份胶水、1 秒），
  子进程带 `NODE_COMPILE_CACHE`（55 MB 的解析省一半），子进程自己有 45 秒上限。
* `sd(c(1,2,3,4))` 还回 -3（R 里报错）：`sd` 是 **base 包的 R 代码**，那要
  `R_LoadProfile` + 序列化过的 base ——下一刀。
* 欠的一步仍是 `InitTempDir`（要 `stat`）。

## 第二十二格：初始化那 16 步**一步不欠**（已落，2026-09-28）

`InitTempDir` 是最后一步欠账。追下去是四个 libc 的洞，一个一个补，每补一个
判据往前走一格（这一路的报错都很明白：`xxx: libc: 没有这个函数`）：

`stat` → `access` → `mkdtemp` → `setenv`。

### `struct stat` 的布局**不在 JS 里抄**

`stat` 这一格的做法值得单记。`struct stat` 的布局是**平台的事**（macOS 上
`st_mode` 在偏移 4、`st_size` 在 96…），在 JS 里按偏移写等于把平台 ABI 抄第二遍 ——
抄错一格是静默答错。所以分两层：

* 宿主那侧只回**一串数**（`__omni_stat`，13 个 i64，我们自己的口径）；
* `struct stat` 由 **C** 那边填（`ext/r/rt/omni_libc.c`），偏移让编译器按头文件算。

`lstat` 同一个身子、只差"跟不跟符号链接"。

### 宿主面那张白名单是有判据的

第一版 `statInfo` 直接写进 `src/core/host/native.js`，`tests/mir/run.js` 的
`lower/cli.js` 当场红：`'statInfo' is not part of the native host surface`。
那张白名单（`frontend-js/link.js` 的 `NATIVE_OPS`）是自举那条腿的契约，
不为一格 libc 扩面。于是改成**用已经在面上的四条拼**：
`exists` / `isDir` / `fileSize` / `mtimeMs`。

代价说清楚：权限位是编出来的（目录 `0755`、文件 `0644`），`st_uid`/`st_ino` 是 0，
`access` 于是"在就都能"。R 那一路问的是"在不在、是不是目录、多大、多新"——
这四样是真的。真要按权限分叉得往白名单上加一条 op，那是另一刀。

### 账

* `tests/r/rtc.js jsrun`：**16/16 步初始化都过**（`INIT_ALLOW_FAIL` 清空了），
  18 句 R 与 Rscript 对得上，30 秒一趟。
* 软缺的天花板 203 → **195**（`stat`/`lstat` 由我们自己的 C 提供，另六个进了 libc）。
* `getpid` 没补（`InitEd` 要它，而那一步不在这条路上）—— `mkdtemp` 的随机改用单调时钟。

## 第二十三格：base 那个包**装得动了**，但还不够快（2026-09-28）

`nchar` / `paste0` / `mean` / `sd` / `sapply` 都不是 C 写的 —— 它们是 base 包里的
R 函数（身子常常只有一句 `.Internal(...)`）。装它们照 R 自己那一段（main.c 1045-1073）：
`Init_R_Variables(R_BaseNamespace)` -> `R_OpenLibraryFile("base")` -> 一句一句跑。

落在 `ext/r/rt/omni_rhost.c` 的 `omni_base_init()`。路上三件事：

1. **`R_Home` 要自己填**。`R_OpenLibraryFile` 按它拼
   `R_HOME/library/base/R/base`，而填它的是 `Rf_initialize_R`（我们不叫那一句）。
   不填就是 `fp == NULL` —— 头一版那个"ok"其实是"没抛异常"，回值才是 -1。
   **判据要看回值，不要看"没炸"**。
2. **`R_ReplFile` 调不到**：它在 main.c 里是 `attribute_hidden`（文件局部），
   跨模块不导出。报的是 `R_ReplFile: libc: 没有这个函数` —— loud 不 silent，正是要的。
   所以那一圈自己写：`R_Parse1File` 一句一句读、`R_tryEval` 一句一句在 base 的命名空间里跑
   （`R_Parse1File` 是导出的）。
3. **它慢**：base 是 1.4 MB 的 R 源码，一趟 >50 秒还没完。所以这一格**先不进判据** ——
   判据不许一趟一分钟（`tests/r/rtc.js jsrun` 现在 31 秒）。那 5 句 R 也先留在表外。

### 量出来的速度（`.omni-cache/probe/reval.js`）

**约 30 句/秒、前 250 句一个错都没有**（`R_Parse1File` + `R_tryEval` 一句一句）。
base 的顶层语句是一千多句，所以整份要一分钟上下 —— 是"慢且线性"，不是"卡住"。

顺带一个查法记下来：C 那侧的 `printf` 是**攒着的**（退出时才吐），而这种探针常被
`timeout` 砍掉 —— 砍掉就什么都看不到。所以进度那几行每行 `fflush(0)`。

### 下一刀的三条路（按"省力"排）

1. **内存像快照**：base 装完之后把线性内存整块存下来，下次开机直接铺回去
   （我们的内存就是一个平坦的缓冲，`memData` 就能写回）。一次性的一分钟变成一次性的
   几十毫秒 —— 而且浏览器那一趟本来就要一份"开机镜像"。
2. **R 自己的 lazy-load 数据库**：真实 R 装出来的 `library/base/R/base` 是个壳，
   里头 `lazyLoad("base")` 去读 `base.rdb`/`base.rdx`；我们这棵树里它是**拼起来的源码**
   （`ext/r/build-libR.js` 没造那个库），所以现在必须现场解析 1.4 MB。
3. **压 JS 腿的常数**：先量清楚 30 句/秒里解析、求值、GC、我们的内存访问器各占多少。

## 第二十四格：开机镜像的机件（已落）+ 速度那三笔账（量出来了，2026-09-28）

### 机件：一段一段装，装完存像

* `RT.memImageSave()` / `memImageLoad()`（`interp/builtin.js` 的 `memImage`/`memImagePut`）：
  整块线性内存存下来 / 铺回去。`heapBase`/`errnoAddr` **不进像** ——
  每趟开机那串 `$init()` 都把它们摆成同一个值；`brk` 在内存里（`heapBase` 那 8 字节），
  所以它进像。
* `omni_base_step(from, cap, &endpos, &nerr)`（`ext/r/rt/omni_rhost.c`）：
  从字节偏移接着装 `cap` 句，把停下来的偏移写回去。**为什么要"一段一段"**：
  装整份 base 一分钟，而一趟不许超过一分钟。
* `ext/r/build-rimage.js`：一轮铺回上一轮的像、接着装、再存像。
  第一轮量出来：**300 句 9.1 秒、0 错、像 290 MB**（gzip level 1 之后几 MB）。

### 三笔速度的账（都是量出来的，别再猜）

1. **装载那 30 秒是大头，而它是"代码多"不是"数据多"**。
   data 段改成 base64 递进来（`b64()`，编解码都自己写 —— 封闭子集里没有 `Buffer`，
   `tests/mir/run.js` 的 `lower/cli.js` 当场红过一次），57.2 MB 只掉到 56.7 MB ——
   也就是说那 57 MB 几乎全是**函数体**（227093 个函数）。
2. **按根集合算闭包只省得下 17 份**：`cJsModules` 现在报 `deps`，判据按"我要叫的那些
   符号"求传递闭包 —— 251 份变 **234 份**。R 的模块互相咬得太紧，这条路到头了。
3. **`NODE_COMPILE_CACHE` 有用但不够**：62 秒一趟降到 47 秒；装载仍是 30 秒上下。

### 下一刀只剩两条真路

* **打成一份**（251 -> 1）：一份 `.mjs` 里 V8 只解析一次、没有 251 次模块解析与实例化。
  要在链接那一层把每份的 `$f*`/`$B`/`$k*` 换名或包进函数作用域，
  `import` 换成模块间的直接引用（有环那几处要留成惰性取值）。浏览器那一趟本来也要这个。
* **MIR 层剪枝**：从根集合出发按 CALL 边走，把够不着的函数整个不发。
  `R_FunTab` 那张表把所有 `do_*` 都拽住了，所以先要把"表里的地址"也算成根 ——
  能剪掉多少要量。

## 第二十五格：按需 import（已落，2026-09-28）

上面那两条路都没走 —— 打包这条被否掉了："c 编译为 js 需要的是**自动处理依赖和按需
import**，而不是整体塞进去。" 落下来的形状是**惰性桩 + 链接图**：

* 跨模块的函数**不再静态 import**，发出来的是一个桩：
  `let $cN = null; function $fN(...a) { if ($cN === null) $cN = needFn("名字"); return $cN(...a); }`
  —— 第一次被调到那一刻才去找提供它的那一份。
* 运行时那一侧（`js_rt.js`）多三件东西：`setLinkMap(map, loader)`（名字 -> 文件，就是
  `.syms.json`）、`needFn(name)`（表里没有就按图装那一份，装完再查一遍，还没有就 loud 喊）、
  `linkStats()`（真起来了几份）。装载器在 Node 上是 `createRequire`（Node 23 起
  `require` 能同步吃 ESM，所以惰性桩不必是 async）；浏览器那一侧是同一张图，预热用
  `await import`。

### 量出来的数（`tests/r/rtc.js jsrun`）

* **起来 50/251 份**就把 R 的 16 步初始化 + 18 句 R 跑完了（其中 45 份是按图装的，
  另 5 份是被别人的**数据符号** `import` 顺带拉进来的）。
* 那一节整趟 **4.8 秒**（命中发射缓存）。从前是 47~62 秒 —— 30 秒那道线以下了。

### 三条缝，都是"次序/幂等"这一族

1. **堆立不起来**：`memAlloc` 在"堆已经在内存尾上了"之后改从堆里要（不然晚来的模块
   会把连续的堆堵死），而 `memHeap` 又是**先挂牌再要那一页** —— 于是第一次 `malloc`
   叫 `memHeap`、`memHeap` 叫 `memAlloc`、`memAlloc` 看见牌子又去叫 `malloc`。
   `libc: malloc 之前堆没有初始化` 这句话是真的，只是原因在三层之外。
   改法：**先要那一页，再挂牌**。
2. **漏叫 `$init()`**（上面记过一次的那格，这回结构性地封了）：按需装载里压根没有
   "入口那一层把每份的 `$init()` 叫一遍"，而一份模块可能只是因为别人要它的数据符号
   才被 `import` 进来的 —— 那样它的 `$g0`（影子栈顶）还是 `undefined`，头一次进它的
   函数就是 `Cannot mix BigInt and other types`。改法：`$init` 幂等（`$inited` 一道闸），
   **模块末尾自己叫一遍** —— "被 import 进来就算装载"。
3. **判据把真话吞了**：`$F = (s) => { try { return needFn(s); } catch { return null; } }`
   把"堆没起来"印成了"没这个符号"。凡是 catch 住的地方都要把原话记进日志。

### 顺手修的一格性能账

`tests/r/rtc.js` 的发射缓存 key 里**不再放 `src/core/mir/js_rt.js`** —— 它是运行期那一份
（模块只 `import` 它的路径，内容一个字都不进发出来的文本）。放着的代价是"改一行运行时
就重发 251 份、白等 45 秒"，而那 45 秒里没有一个字节会变。

## 第二十六格：base 进判据，顺着它抓出两条真缝（2026-09-28）

`tests/r/rtc.js base`：按需装载那套胶水（起来 38 份）+ `omni_base_step` 一轮一轮装
base 的 R 源码。**判据是固定句数不是固定时间** —— 时间预算那种写法机器一忙就少装几百句
（量到过 1100 / 900 两个数），地板会时绿时红。现在装满 **800 句、0 错**，时间反过来
当天花板（18 秒）；整趟 12 秒。

往 800 句之后走，撞出两条：

### 一、`stpcpy` 没有（loud，好办）

R 的 `do_paste`（main/paste.c）拼字符串用 `stpcpy`（回"写完那个 NUL 的地址"）。
补上 `stpcpy`/`stpncpy`，**按字节抄**不经 JS 字符串 —— base 里有非 ASCII 的串。

### 二、`3141592653U` 被当成了 `unsigned long long`（静默答错，这条是真缝）

`duplicated(c(1,2,2))` 在 JS 腿上 `memory access out of bounds: 25126669600+4`。
往上追到 `src/main/unique.c` 的

```c
static hlen scatter(unsigned int key, HashData *d)
{ return 3141592653U * key >> (32 - d->K); }
```

发出来的 JS 是 `$W(3141592653n * v1)` —— **64 位乘法，不回绕**。C 里两个操作数都是
`unsigned int`，乘积必须模 2^32。根在词法那一层：`tccpp.js` 的整数常量定型两种情形
都拿 `0x7fffffff` 比，于是带 `U` 的 `3141592653U` 越过 32 位那一档成了
`unsigned long long`。按 C11 6.4.4.1 表 1 分三列重写：

* 带 `U`：`unsigned int` -> `unsigned long long`（界 `0xffffffff`）；
* 十进制无后缀：只有符号那一列（界 `0x7fffffff`）；
* 十六/八进制无后缀：`int` -> **`unsigned int`** -> `long long` -> ...（`sizeof(0xffffffff)` 是 4）。

**为什么整数那一路没炸只是错**：`duplicated(c(1L,2L,2L))` 也走同一个 `scatter`，
下标落到哈希表外但仍在内存里 —— 答对了是碰巧。这就是"宁可 loud 也不许静默答错"
那条规矩要抓的形状。判据钉在 `tests/c/gen/91-uint-constant.c`（与 cc 逐字节相同）。

### 三、少一步 `InitDynload`（base 最后一句要它）

base.R 最后一句是 `getDLLRegisteredRoutines("base")` 那一段（把 `.F_dqrcf` 一族
绑到 `.BaseNamespaceEnv`）。我们的 16 步初始化照 `setup_Rmainloop` 抄，但**漏了
`InitDynload()`**（main.c:992，在 `InitGlobalEnv` 与 `InitOptions` 之间）——
于是那一句报 `No DLL currently loaded with name or path 'base'`。补上之后它自己就过了
（`InitDynload` 里 `addDLL("base")` + `R_init_base(dll)`）。

连带补了 `getrlimit`/`setrlimit`：`initLoadedDLL` 按 fd 上限算"最多装几个 DLL"。
这条腿上没有 fd 这回事（句柄是我们自己发的号），所以给 4096 —— 够它算到 614 个 DLL。

### base 现在的账（全份）

`.omni-cache/probe/base-all.js`：**整份 base 装完、0 错**、走到字节 837930、
16.8 秒、按需起来 **54 份**。判据里那一节只装 800 句（7~8 秒），因为整份加上开机
那 17 步就压着 30 秒那道线 —— **下一刀是开机镜像**，把这 17 秒变成一次性的。

### 一笔反直觉的性能账：一趟别装太多句

`omni_base_step(from, cap, …)` 的 `cap` 从 100 调到 800（少 7 次 `fopen`/`fseek`，
"显然更快"），同样 800 句 **8.3 秒变 22.3 秒**；而且多出来的那 14 秒不在 CPU 上
（`real 26.6s` vs `user 13.2s`）。一趟 C 调用里连着跑几百句 R，等的是别的东西 ——
真因还没追，记在这儿。

## 第二十七格：开机镜像，17 秒变 2 秒（已落，2026-09-28）

装整份 base 要 17 秒，而装完的结果**全在线性内存里**（堆、SEXP、符号表、brk 都是字节）。
存一份、下次铺回去：`tests/r/rtc.js img` 量到 **47 份模块 + 80 MB 的像铺回去 2.6 秒**，
装 base 那 1300 句一句不用重跑，7 句 base 的函数（mean/nchar/sapply/paste0/duplicated/
strsplit/vapply）都与 Rscript 对得上，**铺完到答完 3.8 秒**（整节 7.3 秒）。

### 按需装载与镜像是**冲突**的，冲突点是"基址浮动"

像里的指针全是绝对地址。而按需装载那条路上，一份模块的数据段在哪儿取决于
**它是第几个被装进来的**（`memAlloc` 的 bump），甚至取决于"堆是不是已经在尾上了"
（堆立起来之后模块的数据段改从 `malloc` 要）。所以照着旧办法"重来一趟再铺像"
必然错位 —— 而且是**静默**错位。

解法是把基址**钉住**：

* 发射那一侧：`const $B = memAlloc(span, 16, "<这份模块的落盘路径>")` —— 多一个记号。
* 运行时那一侧：`setBaseMap(表)` 之后，`memAlloc` 见过这个记号就回那个地址
  （并且**也记一笔** —— 存像是一轮一轮的，这一轮存下去的表必须带上上几轮钉住的）；
  钉住的那一段要自己 `memEnsure`（漏了报 `memory access without a memory`）。
* 堆那一页也钉（记号 `$heap`），不然 brk 与堆里所有指针全歪。
* 存像时把 `RT.baseLog()` 与**装载次序**一并写进 `base.json`；铺像那一趟
  先 `setBaseMap`、按次序把那几份装进来（`$init` 幂等，见第二十五格）、再把字节铺回去。
  次序要留着不是为了基址（基址已经钉住了），是为了"哪几份得先在场"。

### 造像也一轮一轮（一轮 30 秒以内）

`node ext/r/build-rimage.js` 一次跑一轮：有上一轮的像就先铺回去、接着装 600 句、
再存像。量到三轮装完（600 / 600 / 100 句），每轮 8~16 秒；装完之后再跑一次就是
"铺像 + 问几句 R"那一趟（3.6 秒）。判据那一节（`rtc.js img`）只做后者。




