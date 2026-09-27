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
