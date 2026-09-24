# ADR-0046：R 这条腿要 libR —— 我们自己从 r-source 编出它，但不要 R 自己那个编译器

状态：进行中（第一刀已落：`src/main` 100 份 C 全编过）

## 背景

`ext/r` 这条路走到这里是一个**编译器**：R 的语法（从 `gram.y` 复刻）→ 标准 IR → 公共 lower →
`.sx` → JS / 原生。数值那一族借 R 自己的 C（nmath，我们用自带的 ninja 编出
`libomniRmath`），值与印法逐字节对 `Rscript`（`tests/r/oracle.js` 19 格）。

这一路能走多远是量过的：ggplot2 4.0.3 连它的 16 个依赖（cli / rlang / vctrs / scales /
S7 / cpp11 / farver / isoband / …）一共 **135 523 行 R + 102 848 行 C/C++**，而那些 C/C++
引用了 **388 个 R 内部 C API 符号**（`Rf_eval` / `Rf_allocVector` / `Rf_defineVar` /
`R_NilValue` / `R_RegisterCCallable` …）。也就是说"跑得起 CRAN 的包"不是"再接几个内建"，
而是要一套**真的 SEXP 对象模型 + GC + 求值器**。自己重写那一层等于重写 R。

## 决定

**libR 由我们自己从 r-source 的 C 编出来**（同一把 ninja，规则还是 JS 写的），
`R` 这门语言在它上面跑；**不要 R 自己实现的那个编译器**（`src/library/compiler`
那个用 R 写的字节码编译器）——"编译"这件事是我们的活。

于是这条路上的三条边界是清楚的：

* **要**：r-source 的 C / Objective-C 全都可以要 —— `src/main`（求值器、SEXP、GC、
  connections、格式化）、`src/appl`、`src/unix`、`src/extra/{tre,tzone}`、`src/nmath`、
  以及 grDevices 里 R 自己那份 **quartz 设备**（`devQuartz.c` + `qdCocoa.m`，它自己
  `NSWindow` / `NSView`，只链 `-framework AppKit`）。窗口那一格就走它，不走浏览器。
* **不要**：R 的字节码编译器（`compiler` 包）。base 那几个包按不字节码编译的方式装，
  JIT 关掉。
* **不装 R**：本机那份 R 只当尺子（`Rscript` 是判据，`bench/r/run.js` 是性能参考），
  运行时一格都不借。

## 第一刀（已落）

`ext/r/rt/gen-rconfig.js`：从 `src/include/config.h.in` 生出**整份** `config.h`。
不跑 R 的 configure —— 那是 autoconf + make 那一套；这儿把它做的事按种类分开做：

* `HAVE_<X>_H` 真编一遍 include；`HAVE_<FUNC>` 真编 + 真链；`HAVE_DECL_<X>` 回 0/1；
  `HAVE_<X>_T` 量类型；`SIZEOF_X` 真跑一趟 —— 一共 **282 格靠探针**
* 探不出来的 **139 格在一张显式的表里**，每格写值与依据（darwin 的内部时区码、
  quartz 开、X11/cairo/ICU/NLS/OpenMP 不开、gfortran 的名字修饰…）
* **表里没有、又落不进探针的名字当场报**（连名字一起印）。这一条挡住了四个真坑：
  `HAVE_DECL_SIZE_MAX` 的符号是**大写**（只按小写探会答 0，然后 `Defn.h` 那句
  `#error SIZE_MAX is required for C99` 把整棵树挡住）、`HAVE_PTHREAD` 是**库**不是函数
  （漏了它 `eval.c` 的 `__APPLE__` 分支编不过）、`HAVE_STACK_T` 是**类型**不是函数
  （漏了它 `main.c` 走进 macOS SDK 里不存在的 `struct sigaltstack`）、
  `HAVE_POSIX_LEAPSECONDS` 得跟 `USE_INTERNAL_MKTIME` 一起开（`n_leapseconds` 只在
  另一支里定义）。

`Rconfig.h` / `Rversion.h` 不用新写生成器 —— r-source 自带 `tools/GETCONFIG` 与
`tools/GETVERSION`，我们照着 `src/include/Makefile.in` 第 70..73 行那两条规则跑一遍就行
（`GETVERSION` 认的是 `../../SVN-REVISION`，所以要在 `<gen>/src/include` 里跑）。

**量出来的结果：`src/main` 那 100 份 C（105 减去 4 份只被 include 的、加上 macOS 上不编的
那几份替代品）一份不差全编过。**

## 接下来（按刀排）

1. ~~`src/appl`（6 C + 14 Fortran）、`src/unix`（6 C）、`src/extra/tre`、`src/extra/tzone`，
   连 `src/main` 一起链成 `libR.dylib`~~ —— **已落**（`ext/r/build-libR.js`，249 条边）。
   BLAS / LAPACK 走 Accelerate；gfortran 是 Homebrew GCC 16.2。
2. ~~一个 `Rscript` 形状的驱动~~ —— **已落**：`R.bin` 就是 R 自己的 `src/main/Rmain.c`
   链我们的 libR（`Rmain.c` 不在 `SOURCES_C` 里，R 自己也是只把它链进 `R.bin`）。
3. base 那几个包：**base 已落**（按 `share/make/basepkg.mk` 的 `mkRbase` + `mkRsimple`
   装成源码：`library/base/R/base` 就是 `all.R`，22 700 行）。`.Library` 在系统 profile 里定
   （`src/library/profile/Common.R` + `Rprofile.unix` 接起来），少了它 R 起不来。
   **别的十一个包也已经编好装好**（tools / compiler / utils / methods / stats / graphics /
   grDevices / grid / datasets / splines / stats4：R 代码按 `LC_COLLATE=C` 接起来、
   `NAMESPACE` 与 `DESCRIPTION` 就位、`src/` 的 146 份 C/Fortran/Objective-C 编出了八份
   `<pkg>.so`，名单都从**那个包自己的 `src/Makefile.in`** 里读）。
   **卡在一格上**：见下面"第三刀卡住的地方"。
4. `install.packages` 装那 17 个包 → `library(ggplot2)` → `ggsave` 出一张图。
5. quartz 那一格：`devQuartz.c` + `qdCocoa.m` 编进来，`plot()` 开一个真窗口。
   它自己建 `NSWindow`、不跑 `[NSApp run]`（靠 `ptr_R_ProcessEvents` 协作抽事件），
   所以要在主线程上调 —— 这一条与我们 host 那侧的线程安排得对齐。

### 第三刀卡住的地方（量出来的，别再从头猜）

`library(stats)` 起不来，链条是这样的：

1. tools 的 `R/zzz.R` 有一句**顶层**的
   `PS_sigs <- getDLLRegisteredRoutines("tools")[[c(".Call","ps_sigs")]]`，
   拿到 NULL 之后下一句 `.Call(PS_sigs, 1L)` 报"第一个参数得是字符串或本机符号"；
2. 往上一层：`getDLLRegisteredRoutines(dll)` 回的三张表**全是空的**（`.Call` 0 个）；
3. 再往上：`unclass(getLoadedDLLs()[["tools"]])$dynamicLookup` 是 **TRUE**，
   而 `R_init_tools` 里明明有 `R_useDynamicSymbols(dll, FALSE)` —— 所以那个 init **没被调**；
4. 根上：在 R 里 `getNativeSymbolInfo("R_init_tools", PACKAGE="tools")` 报"no such symbol"，
   `.Call("ps_sigs", 1L, PACKAGE="tools")` 也报 not available ——
   **`dlopen` 成功了，但这份 `.so` 里一个符号都 `dlsym` 不出来**。
   而 `nm -gU tools.so` 明明列着 `T _R_init_tools` 与 `T _ps_sigs`。

也就是说问题不在 R 那一侧，而在**我们怎么链这份 `.so`**。链接参数与 R 自己的一样
（`configure.ac` 第 1539 行：`-dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup`，
本机装的 R 的 `Makeconf` 也是这一行），所以下一步该做的是把两份 `.so` 摆在一起比：
`otool -hv` 看 filetype 与 flags（MH_DYLIB vs MH_BUNDLE、TWOLEVEL vs FLAT）、
`otool -l` 看有没有 `LC_DYSYMTAB` 的导出项，再试 `-bundle` 与 `-Wl,-flat_namespace`。
这一格的判据已经摆在 `pkgs.ok` 那条边上（默认目标不挂它，所以尺子还是绿的）。

### 第二刀量出来的三格

* **`R_ENABLE_JIT=0` 是硬要求，不是偏好**：不关的话 R 起来就去加载 `compiler` 包，
  而那个包我们不装 —— 报的是 `package 'compiler' does not have a namespace`。
* base 的 `all.R` **次序要紧**（`LC_COLLATE=C ls R/*.R R/unix/*.R`），
  而拼它的那条命令里一格 `$` 都不能留：它要过一遍 ninja 的模板展开，`$f` 会被当成变量展成空。
  所以用 `xargs cat`，不用 shell 的 for。
* `tools/GETVERSION` 认的是 **`../../SVN-REVISION`**（相对 CWD），所以它得在
  `<gen>/src/include` 里跑；参考树是 git 检出、没有那份文件，我们自己写一份。


## 后果

* R 这条腿从此有**两档**：编译器那一档（`omni run x.R`，快 —— `bench/r/run.js` 上标量循环
  比 Rscript 快 40 倍）与 libR 那一档（能装 CRAN、能画 ggplot2）。两档的判据不同，
  别混在一把尺子里。
* 仓库里照旧**不落 R 的代码**：只有构建规则与生成器，源码从参考树读（与 nmath 同一条）。
