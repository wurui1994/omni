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

**还差的另一半**：代码里那些"其实是地址"的 i64 常量（`const k5 i64 65552`）——
搬 data 段时它们也得跟着加同一个差，而今天它们与普通整数长得一模一样。
那一半的落法是让这条腿上的地址发成**符号**（`GADDR` 那一格在 `ir.js:406-409` 的注释里
早写好了"线性内存那条腿上是 data 段里的偏移"），或者退一步：给"这是地址"那些常量记一格
标记。两半都齐了，"搬一个差再跑一遍"才是可判的 —— 那就是链接器的第一刀。

## 账

* 122 份 `.c` 摊成 15 641 字节的 `nmath-lib.c`（`#include` + `#define`/`#undef`，
  不含 R 的源码本身），两个驱动各包它一次。
* 改名的 `static`：10 个名字、22 处。
* `node tests/r/cjs.js` 全过（20/20）：66 格数 + 一张 7547 字节的 SVG
  + 两张 480×320 的 PNG（交帧那一档与设备自己的笔那一档，各自两条腿逐字节相同）
  + 摊平预处理那一份 550 365 字节的自足 `.c` 在 **node 壳子与真浏览器**里画同一张图。
* `node tests/c/run.js` 112/0（`sys/` 那 5 格是这一刀新上 JS 腿的）。
* 产物落 `.omni-cache/r-rt/js/`（约定：生成物不进版本库，也不进临时目录）。
