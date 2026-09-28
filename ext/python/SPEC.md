# python —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。正本是参考树 `~/Documents/Lang/reference/cpython`
（`OMNI_REF_DIR` / `CPYTHON_SRC` 可以改），现在是 **3.16.0a0**。

## 一、这一门怎么摆：解析与执行归我们，运行时借 CPython 的 C

这是这门语言唯一的架构决定，其余全从它推出来。

**借的那一半（CPython 的 C）**：**运行时整份**（口径与次序见 §一之二）。下面这几格是
最先撞上、也最说得清"为什么非借不可"的 —— 它们都属于"位对位才算对而且重写要一年"那一类。

- 浮点转串（`Python/dtoa.c` + `Objects/floatobject.c` 的 `float_repr`）—— `repr(0.1)`
  印 `0.1` 而不是 `0.1000000000000000055`，靠的是最短往返那套算法。
- 大整数（`Objects/longobject.c`）—— python 的 `int` 没有上界，`2**1000` 得真算。
- 串与编码（`Objects/unicodeobject.c`、`Objects/stringlib/`、`Modules/_codecs*`）——
  大小写映射、`str.format` 的格式微语言（`Python/formatter_unicode.c`）、各国编码表。
- 哈希（`Python/pyhash.c` 的 siphash）—— `hash()` 的值与字典/集合的迭代次序由它定。
- 正则（`Modules/_sre/`）—— 这一格是 python 语义的一大块，重写等于重写一个引擎。
- 数学与随机（`Modules/mathmodule.c`、`_randommodule.c` 的 MT19937）—— 与 R 那一门
  同一个道理：随便换一条发生器，同一份程序就答不出同一个数。

**不借的那一半（这是"解析和执行走我们"那句话的具体内容）**：

- `Parser/`（PEG 解析器、`pegen.c`、tokenizer）—— 语法走 `python.grammar` + 这套 GLR。
- `Python/compile.c` / `flowgraph.c` / `codegen.c`（出 CPython 字节码的那一串）。
- `Python/ceval.c`（字节码解释器）—— 执行走标准 IR → `src/core/lower/` → MIR → 各后端。
- `Python/import.c` 那套 import 机器 —— 模块解析归驱动层（`drive.js` 的 `imports` 那一格）。

也就是说：**一份 .py 进来，出去的是我们的 MIR**，跑在 C 腿或 JS 腿上（**JS 腿也是从
那份 C 编出来的** —— 见 §一之二）；`repr(1.1)` / `int` 溢出 / `re.match` 这类格子调的是
借来的那份运行时（CPython 的 C，我们的 ninja 编，我们的 C 前端编进同一个产物）。
不起 `python3`、不 `dlopen` 本机的 `libpython`、不走它的字节码 —— 那样就成了
"套壳 CPython"，一格语义都学不到。

R 那一门（ADR-0045/0046/0047，`r-lang` 分支）已经把这条路走通过一遍：`ext/r/build.js`
编 nmath、`ext/r/build-libR.js` 编整份 libR，两份都用 `src/core/build/api.js`
那台 JS 写的 ninja，产物落 `.omni-cache/`。python 这一门照同一个形状办，差别只在
"借哪几份 .c" 与 "`pyconfig.h` 怎么生"（对应 R 的 `gen-rconfig.js`）。

### 一之二、**运行时整份借，库函数不一格一格自己写**（2026-09-27 扳回来的一条路线）

上一节说"借哪一半"，这一节把它说到底 —— 这条线被走偏过两回，所以写死在这儿。

**不借的只有三件事**：`Parser/`（解析）、`compile.c` / `codegen.c` / `flowgraph.c`
（出 CPython 字节码）、`ceval.c`（那台字节码解释器）。除此以外，**运行时可以全部是
CPython 的**：对象层（`Objects/unicodeobject.c` / `listobject.c` / `dictobject.c` /
`longobject.c` / `floatobject.c` / `abstract.c`）、内建（`Python/bltinmodule.c`）、
那几个 C 模块（`_sre`、`mathmodule`、`_randommodule`、`_codecs*`）。

**主路线是编到 C**：`.py` → 我们的 IR → `src/core/lower/` → MIR → **C**，
与借来的那几份 `.c` 一起编、一起链。**JS 腿也从这份 C 来**（C → 我们的 C 前端 → MIR →
JS 后端），不是另写一份 JS 运行时。这一格是量过的，不是设想：

```
$ node src/cli.js run --mode js /tmp/zf.c     # 一份 C 里手写的 zfill
-0007
```

于是有两条推论，都要当规矩用：

1. **`ccall` / ffi / N-API 那条路不必走了**。从前记在"下一刀"里的卡点
   （`cabi` 的类型词里没有"出串那一格"、`ccall` 在 JS 腿上要 N-API 扩展、接上之后
   `omni run` / `--mode js` 会退档）是**按"外部共享库 + ffi"想出来的**。按"把那几份 .c
   编进来"这条路：没有 ffi、没有退档、三条腿是同一份实现。
2. **库函数不再一格一格自己写**。既不在 adapter 里用 JS 铺 IR（那是走偏的第一回），
   也不在 `ext/python/lib/*.py` 里用 python 写一遍（那是走偏的第二回 —— 层对了，
   可工作量还是"有多少库函数就写多少"）。**adapter 碰到一处库调用，发的是"往借来的
   运行时里调一格"**；CPython 有多少库函数，我们就有多少，不靠一格一格补。

**必须先定的那一格：值怎么表示。** 借来的运行时吃的是 `PyObject *`（带引用计数），
而现在编出来的 C 用的是我们自己的 `string` / `arr` / `dict`（不装箱、无 GC）。两条路：

- **(a) `PyObject *` 打通到底**。python 的值就是 `PyObject *`，`a + b` 落成
  `PyNumber_Add`，`s.zfill(4)` 落成 `unicode_zfill`。语义**全对**（大整数、
  `str` 的编码、哈希次序、`re`），因为那就是 CPython 的语义。
  代价：现在这套类型推断与单态化**不再是正确性的前提，而成了优化**
  （推得出 int 的那几格才拆箱成机器整数）。要接引用计数与 GC（`Py_INCREF` /
  `Py_DECREF` 那一套在 C 里是现成的，我们只要发对）。
- **(b) 边界上转换**。我们自己的表示照旧，只在调库时转成 `PyObject *`、回来再转回。
  好处是今天这套快路径不动；坏处是**语义在边界上会漏**（大整数一转就截、串的编码
  一转就成字节），而且每次调用都有一次转换 —— 等于把"位对位才算对"那件事又交回给我们。

**倾向 (a)**，理由与上一节同一条：这一门的价值在"语义与 CPython 逐位相同"，
而 (b) 把最难的那几格又搬回自己这边。(a) 的次序应当是：先把对象层与 `bltinmodule`
编进来（`build.js` 已经会编 `dtoa.c` / `pystrtod.c`，形状是现成的），拿**一格**方法
（`.zfill`）走通"编到 C 腿 + 编到 JS 腿"，再按族替换，替换到哪儿、哪一族还在旧路上，
都记在 §二。这一格定下来之前，**不许再往"自己写一份库函数"那个堆上加东西**。

**现状（这句话要跟着改）**：借来的那份 `libomnipy` 现在只编了
`dtoa.c` + `pystrtod.c`，而且**还没链进 python 程序**；所有库函数走的还是编译期展开
那条旧路（约 3840 行 JS），外加 `ext/python/lib/str.py` 里那四格（补宽度那一族，
机制的一格样品：库函数用 python 写、由这条链自己编、按调用点单态化、没人用不发）。
那四格**不再长**；下一刀是把对象层借进来。

**量到哪儿了（2026-09-27，第 0 刀的 (b) 那一步）**

1. **我们自己那台 C 前端编得下 CPython 的 C** —— 第一格判据过了：

   ```
   $ node src/cli.js c obj -I … cpython/Python/dtoa.c -o /tmp/dtoa.o
   $ ls -la /tmp/dtoa.o          # 46414 字节，真的目标文件
   ```

   2841 行的 `dtoa.c`（David Gay 那份，一个字没改）**一遍过**。顺手记一条口径：
   库那样的翻译单元要走 `omni c obj`，不是 `omni c mir` —— 后者是"一遍过编到 MIR"，
   它要所有符号都解析得上（`dtoa.c` 里 `omni_py_interp` 是外部的，那儿就会报
   `undefined symbol`）。

2. **卡住的不是 C 前端，是我们那层地板太薄**。`Objects/unicodeobject.c`（15436 行）
   报在 `Include/internal/pycore_abstract.h:65`：`PySendResult` 没定义 —— 那是
   `Include/cpython/abstract.h` 里的一格 enum，而我们的 `rt/shim/Python.h` 只有 92 行，
   是**照"借两份浮点文件"量出来的**（`gen-pyconf.js` 算出来只有 6 个宏进得来）。
   也就是说：**借整份运行时就不能再垫这层薄地板**，形状要换成
   **用 CPython 自己的 `Include/Python.h`**（凡是它有的都用它的 —— 这本来就是纪律第 2 条），
   `rt/shim/` 退回去只给"我们自己那几格 `.c`"用。

3. **`pyconfig.h` 由我们自己探，一行 configure 都不跑**。这一条是纪律，不是省事：
   **不跑 CPython 的 `configure`、不用它的 `Makefile`、不碰参考树**（那棵树是几个 worktree
   共用的只读输入）。`ext/python/build.js` + 那台 JS ninja 从第一天就是照这条写的，
   `rt/gen-pyconf.js` 已经是"照 `configure.ac` 一格一格真探一遍"的形状。
   要长的只是它那张名单 —— 量出来的数（同一套交集算法，`pyconfig.h.in` 的 727 个宏
   ∩ 源码真读到的）：

   - 只 `Objects/unicodeobject.c`：**10** 个
   - `Include/` 整棵（头的链）：**68** 个
   - 对象层那十份 `.c`（unicode / list / dict / long / float / abstract / object /
     bool / tuple / bytes）：**14** 个
   - 合起来：**71 / 727**

   71 个里绝大多数是**机械的**四族，所以 `gen-pyconf.js` 这一刀写成**按族探**
   （探法照 `configure.ac`，不自己发明）：
   `HAVE_<头>_H`（`#include <x.h>` 编得过吗；下划线是目录分隔还是名字的一部分说不准，
   所以几种拼法都试一遍）、`HAVE_<函数>`（自己声明一格取地址、链一遍 —— `AC_CHECK_FUNC`
   的老办法，故意不包那份头）、`SIZEOF_* / ALIGNOF_*`（真跑一遍印 `sizeof` / `_Alignof`）、
   `HAVE_DECL_X`（`AC_CHECK_DECLS` 那一族**总是定义**，有就 1 没有就 0 ——
   CPython 那边写的是 `#if` 不是 `#ifdef`）。
   顺手加了一格 `--extra <相对路径,…>`（目录就整棵走）：**只为"下一批要探多少"这一个问题**，
   不进 `build.js` 那条路。

   量出来的结果（`--extra Include,Objects/那十份`）：**71 个里四族答了 59 个，剩 12 个**。
   而且剩下的这 12 个基本**不是机器能探的，是我们要做的决定**：

   - 分配器：`WITH_PYMALLOC` / `WITH_MIMALLOC` / `PYMALLOC_USE_HUGEPAGES`
   - 整数一位几比特：`PYLONG_BITS_IN_DIGIT`（CPython 在 64 位上默认 30）
   - 要不要留文档串 / DTrace / perf trampoline：`WITH_DOC_STRINGS` / `WITH_DTRACE` /
     `PY_HAVE_PERF_TRAMPOLINE`
   - 线程栈：`THREAD_STACK_SIZE`（CPython 默认 0 = 由系统定）
   - 真探针那两格：`SIGNED_RIGHT_SHIFT_ZERO_FILLS`（跑一遍看右移补什么）、
     `SETPGRP_HAVE_ARG`（编一遍看它收几个实参）
   - curses 那两格（`MVWDELCH_IS_EXPRESSION` / `WINDOW_HAS_FLAGS`）是**扫整棵 `Include/`
     扫进来的**（`py_curses.h`）—— 真借的时候不借 curses，那两格写清"为什么不定义"。

   **所以"借整份运行时"这件事上，configure 不是必需品，那 12 个决定是。** 这一条把第 0 刀
   (b) 的判据说实了：不是"跑一遍它的配置"，而是"这 12 格各自写下决定与理由"。
   `gen-pyconf.js` 那条"**算出来的名字里有一个不认得怎么探就当场报**"照旧 ——
   少定义一格 `HAVE_*` 的后果往往不是编不过，而是 CPython 走进另一条 `#else`、
   在某个角落静默答错。

4. **对象层那一份，用 CPython 自己的头 + 我们探出来的 `pyconfig.h`，clang 编得过了**：

   ```
   $ node ext/python/rt/gen-pyconf.js --src <cpython> --out /tmp/pyinc/pyconfig.h \
       --extra Include,Objects/stringlib,Objects/unicodeobject.c,…      # 75 行，0 个不认得
   $ clang -c -DPy_BUILD_CORE -I /tmp/pyinc -I …/Include -I …/Include/internal \
       …/Objects/unicodeobject.c -o /tmp/uo.o                            # 780656 字节
   ```

   15436 行**一个字不改**编得过。中间还量到一条机制在起作用：头一次少了 `ALIGNOF_LONG`，
   因为它在 `Objects/stringlib/codecs.h` 里 —— 把 `Objects/stringlib` 加进名单，
   那一格自己就被四族里的 `ALIGNOF_*` 探出来了。**名单跟着借的东西长**，不必手抄。

5. **我们自己那台 C 前端到对象层还差一格：原子操作**。同一份文件、同一套开关：

   ```
   $ node src/cli.js c obj -DPy_BUILD_CORE -I … …/Objects/unicodeobject.c -o /tmp/uo.o
   Include/cpython/pyatomic.h:594: error: "no available pyatomic implementation …"
   ```

   `pyatomic.h` 按编译器挑后端：`__GNUC__ >= 4.8` 走 `__atomic_*` 内建、
   C11 `<stdatomic.h>` 走标准那份、MSVC 走它那份，都不成就 `#error`。
   量出来我们这台是 `__GNUC__ = 4`（没有 `__GNUC_MINOR__`）、`__STDC_VERSION__ = 199901L`，
   而 `__atomic_load_n` 与 `<stdatomic.h>` **两样都还没有**（各当场报）。

6. **补上那两格之后往前走了两大步**（这一刀真做了，不只是量）：

   - **C 前端多了 `__atomic_*` 那一族**（`src/core/frontend-c/tccdefs.js`，落成宏 ——
     借了那台前端已经有的语句表达式 `({ … })` 与 `__typeof__`，于是"要一格临时量"的
     exchange / fetch_add 不必按宽度各写一份）。六格算下来与 clang 逐字节相同
     （`41 42 7 1 10 99`）。**这一版落成普通读写**：这条链现在一个线程都不起，
     可观察行为一样；**接线程之前必须换成真的**（那时要落到 MIR 的原子算子上）。
     python 这一侧不去改全局的 `__GNUC_MINOR__`，而是编借来的 C 时明着给
     `-D_Py_USE_GCC_BUILTIN_ATOMICS=1` —— 一处借的决定，不是整条链的声明。
   - **修了一处真的 C 不合规**（`mergeTentative`）：`extern T a[];` 之后
     `T a[] = {…}` 报"incompatible types for redefinition"。三处都错：那个门拿
     `sameType(a,b)` 判（它自己就把"长度不一样"判成不同型）、`extern T a[]` 在这台前端里
     记成 **count 0** 而不是 -1（"没写长度"与"零长"撞一格）、以及"长度是从初始化式数出来的"
     这件事没记。现在门开在**元素类型**上，长度按 C11 6.2.7 第 3 段合并
     （写下来的那个赢），判据是 `sizeof` 与 clang 相同（`[128]` + `{1,2,3}` 出 128）。
     真冲突（`int a[3]; int a[5];`）照旧当场报。

   走到哪儿了：`unicodeobject.c` 现在过了原子那一格、也过了那格数组，**新的边界在
   Argument Clinic 生成的那张关键字元组**上 —— `Objects/clinic/unicodeobject.c.h:230`
   的 `_kwtuple` 静态初始化式报 `constant expression expected`。
   这一轮把它**收到两行**，而且顺手照出一处**静静答错**的：

   ```c
   static PyObject o = PyObject_HEAD_INIT(&PyTuple_Type);   // 两行就复现
   ```

   根子是 `PyObject` 的第一格是个**匿名 union**（`object.h:127`：
   `int64_t ob_refcnt_full` / `struct { uint32_t ob_refcnt; … }` /
   `_Py_ALIGNED_DEF(…) char _aligner` 三选一），而我们这台前端在这两处上还不对：

   - **匿名 union 的成员用嵌套花括号初始化 —— 答错，而且不报**（比编不过坏）：

     ```c
     struct S { union { long full; struct { unsigned r; …; }; char pad; }; void *t; };
     static struct S s = { { 7 }, 0 };
     printf("%ld %u\n", s.full, s.r);   // clang: 7 7    我们: 0 0
     ```

     具名的嵌套结构体是对的（`struct In in;` 那一档答 7），所以缺的正是"匿名成员
     算不算一层花括号"。
   - **`_Alignas` 不认**（`_Py_ALIGNED_DEF` 展开成它）：`error: ';' expected (got '_Alignas')`。
     顺带记一条已有的账：`__attribute__((aligned))` 在这台前端是**吃掉**的
     （见 `tccdefs.js` 的 `COMPILE_PREAMBLE` 那段注释）—— 对齐这件事整体还没落地，
     而 CPython 的对象头正好指着它。

   已经排除的嫌疑（各写了最小复现，与 clang 逐字节相同）：`(long)(3ULL<<30) | ((long)5<<48)`
   那种折叠、`&extern结构.成员.子成员` 与 `&extern数组[2].成员` 那种地址常量、
   `.ob_base = { { {…}, (&T) }, (2) }` 这种**具名**的嵌套指定初始化。

7. **匿名 union 那一格修了，`_kwtuple` 过了，边界推到 2476 行**。

   修法：**初始化式看的成员表与取名字看的那张分开**。`ref.fields` 照旧是**摊平**的
   （`s.full` / `s.ob_refcnt` 要靠它，与 tcc 一条），新的 `ref.inits` 是**按声明**的 ——
   匿名 struct/union 在那儿算**一格**（C11 6.7.9：它就是一个没名字的成员）。
   `initFull` / `initElem` 改用后者（`initMembers()`）。四种形状与 clang 逐字节相同：
   `{ 7, (void*)8 }` / `{ { 9 }, (void*)10 }` 以及 union 在中间的那两种。
   `tests/c` 照旧 106 passed / 2 failed。

   于是那张 Argument Clinic 的关键字元组**编出来了**（`_kwtuple` 那 13 行单独一份 TU
   出 53KB 的 `.o`），整份 `unicodeobject.c` 的边界从 413 行推到 **2476 行**
   （`kind = PyUnicode_KIND(string);` 报 `expression expected`）。
   **那一行单独拿出来是编得过的** —— 两次都验过：`int k = PyUnicode_KIND(s);` 单独一份
   TU 出 `.o`；把 `as_ucs4` 的头十行连着 `#include "Python.h"` 单独编也过。
   所以 2476 不是那个宏的事，是**它前头某处把分析器带偏了**。
   这一轮把它**收进一份 2479 行的截断文件**（原文 1..2478 行 + 一句 `return target; }`，
   `-I <cpython>/Objects` 要带上，`stringlib/*.h` 在那儿）—— 原样复现。

   二分卡在一处**方法**上，记下来免得下次再走：**按行号胡乱截断没用**。
   截在 `#if` 中间报"missing #endif"、截在函数中间报"unexpected end of file"，
   于是六个探点没有一个是有效信号。**认边界的切法不用自己写** —— `omni c split`
   （ADR-0046）的 `scanTopLevel` 就是顶层声明扫描器（用语法定边界、不预处理），
   `ppBalance` 正好答"这一段的条件编译自己配不配平"。两样一凑就是有效的二分。

8. **2476 那一格破了：整份 `unicodeobject.c`（15436 行）编出来了**（1.5MB 的 `.o`）。

   真因**不是**那个宏，也不是"前头某处把分析器带偏了"（那个猜想是错的）——
   是**形参名没遮住外面同名的 typedef**：
   `Include/internal/pycore_asdl.h:14` 真的有 `typedef PyObject * string;`，而
   `Objects/unicodeobject.c:2470` 的 `as_ucs4(PyObject *string, …)` 正好拿 `string`
   当形参名。不遮的话函数体里 `PyUnicode_KIND(string)` 展开出的
   `((PyObject*)((string)))` 被读成**类型转换**（`(string)` 当成了类型名），
   于是报 `expression expected`。C11 6.2.1 第 4 段说的就是这一格。
   局部变量那一路本来是对的（`declareLocal` 那三处都调了 `tdefShadow`），
   漏的只有形参。修在 `src/core/frontend-c/tccgen.js` 的 `runBody`（一行循环），
   判据 `tests/c/gen/87-typedef-shadow-param.c`（`tests/c` 107 passed / 2 failed）。

   **怎么找到的**（方法比这一格值钱）：三段二分，一共十几趟编译、每趟 0.7s。
     1. 顶层格 + 配平那两条当切点，541 格里 11 趟定到"第 183 格"；
     2. 那一格内部按"行首 `}`"再切 —— 意外发现**到 2467 行全绿**，
        于是"前头把分析器带偏"这个假设当场被否掉；
     3. 尾巴钉死成四行小函数、二分**前缀**，落到 `#include "pycore_long.h"` 那一格；
        再逐个删 include 却全绿 —— 说明不是 include，最后对着"绿的那份与红的那份
        逐字节 diff"，差别只剩**形参名叫 `string`**。

   下一格是那条 warning：`__builtin_ctzll` 还只是隐式声明（将来会变链接错）。

9. **对象层现在过了七份**（同一套开关，`Objects/` 下逐份 `omni c obj`）：

   ```
   listobject.c  dictobject.c  longobject.c  tupleobject.c
   bytesobject.c floatobject.c boolobject.c        全部一个字不改编出 .o
   unicodeobject.c                                 15436 行，1.5MB 的 .o
   ```

   还剩三格边界，各有各的性质：
   - `object.c` / `abstract.c` -> `Include/internal/pycore_pystate.h:325`
     **非空的 `__asm__` 模板**（"等自带汇编器"那笔既有欠账，不是这条线上的事）。
     `object.c` 原来卡在第 2400 行的 `_PyObject_HEAD_INIT` 上，那一格已经过了 ——
     真因是**指定初始化符没穿透匿名 struct/union**（`ref.fields` 摊平表的下标被当成
     `ref.inits` 按声明表的序号），修在 `tccgen.js` 的 `initPath`，判据
     `tests/c/gen/88-designator-anon.c`（`tests/c` 108 passed / 2 failed）。
   - `typeobject.c:11720` -> `constant expression expected`：
     `static uint8_t slotdefs_dups[Py_ARRAY_LENGTH(slotdefs)][1 + MAX_EQUIV];`
     要的是 `sizeof` 一个**由初始化式定长**的静态数组（`slotdefs[]`）在静态上下文里求值。
     朴素复现（`static int a[7]; static char b[sizeof(a)/sizeof(a[0])];`）是**绿**的，
     所以真因还没定位 —— 下一刀就是它。二分的办法见上面第 8 条（`scanTopLevel` + `ppBalance`）。

10. **`typeobject.c` 过了，`Objects/` 只剩 `__asm__` 那一族；量尺推到 `Python/` 与
    `Parser/`**（这一轮六刀，`-std=c11` 起）。

    `typeobject.c:11720` 的真因**不是** `sizeof` 也不是"由初始化式定长"（上一条那个
    猜想是错的）：`Py_ARRAY_LENGTH`（`Include/pymacro.h:205`）走的是 GCC 扩展那一支，
    长度算式里明着带着 `__builtin_types_compatible_p` 与
    `Py_BUILD_ASSERT_EXPR`（`((void)sizeof(struct{… _Static_assert …}), 0)`）。
    那一问**表达式那一路早就有**（`gen/74`），缺的是我们那台**只认记号的常量求值器** ——
    它不认那一问、不认 `(void)` 强制转换、也不认括号里的逗号。三格一起补上，
    13007 行一个字不改编出 512KB 的 `.o`（判据 `gen/89`）。

    同一轮顺手落的五刀（每一刀都由 CPython 的某一行逼出来，判据都在 `tests/c`）：
    - `typeof(__extension__ ({ … }))` —— 嵌套的 `Py_MIN`/`Py_MAX`（`pymacro.h:119`）。
      `unicode_formatter.c:197` 那一行是 `Py_MIN(len, Py_MAX(…))`，里层那一整块正好落在
      外层的 `_Py_TYPEOF(...)` 括号里。判据 `gen/90`。
    - `-std=c11` / `-std=gnu11`（tcc 的 `TCC_OPTION_std`）—— macOS 的
      `_static_assert.h` 只在 `__STDC_VERSION__ >= 201112L` 时给 `static_assert`，
      CPython 的 `object.h:145` 也只在那一支上用 `_Alignas`。判据 `cpp/10-std.c` 五格。
    - `_Alignas`（C11 6.7.5）—— `_Py_ALIGNED_DEF`。判据 `gen/91`。
    - 静态初始化式里「算式下标的地址常量」（`&buckets[0+2+1].root`，`parking_lot.c:49`）
      与「带非 ASCII 字节的串」（latin1 单字符表，`pystate.c:309`）。判据 `gen/92`；
      `tests/c/native-gen.js` 的「还没到」那张单子**空了**（90/90，MIN_OK 83 -> 90）。
    - `char d[] = ("abc")`（gcc/clang 的扩展，tcc 不收）—— `pycore_runtime_init.h` 一族的
      `._data = ("<dictcomp>")`。为它新开一组 `tests/c/gnu/`，**尺子换成 clang**。

    量到的账（`Objects` + `Python` + `Parser` 共 **163 份 .c**，同一套开关逐份 `omni c obj`）：

    ```
    编出 .o        133 份（其中 8 份带 warning，见下）
    还编不出        22 份
      非空 __asm__（pycore_pystate.h:325 那一句 `mov %0, sp`）   11 份  <- 我们唯一的真欠账
      头文件不在（emscripten / windows / dl / 生成的 frozen_modules、optimizer.h…） 7 份
      要构建系统给的宏（dynload_shlib.c 的 `SOABI`）              1 份
      `__VERSION__`（gcc/clang 才有，tcc 也没有）                 1 份
      `O_WRONLY` / `F_GETFD` 看不见（我们那份 pyconfig 少了 HAVE_FCNTL_H 一类的格子）2 份
    ```

    也就是说：**除掉「等自带汇编器」这一笔，`Objects/` 下已经一格不剩**，而 `Python/` 与
    `Parser/` 上我们自己的语法/语义一格都不缺 —— 剩下的全是构建系统与平台的事。

11. **那把尺子进仓库了**（`ext/python/rt/sweep.js`，`npm run py:sweep`）。

    上面那张表从前是手工数的 —— 一行 shell 循环跑一遍、数字写进提交信息。那种数字**没人守**：
    下一刀退一格也看不见。现在它是一把能回归的尺子：

    ```
    $ npm run py:sweep
    共 201 份：**编出 .o 199**（干净 199 + 带警告 0）、编不出 2（79s）

    另有 9 份不进分母：
           Python/bytecodes.c —— 不是翻译单元（代码生成器的输入）
           Python/optimizer_bytecodes.c —— 同上
           Python/dynload_hpux.c / dynload_stub.c / dynload_win.c —— 别的平台那一份
           Python/emscripten_*.c（四份）—— 别的平台那一份

    编不出的按族：
        1 份  头文件不在：frozen_modules/…          <- Python/frozen.c
        1 份  头文件不在：Python/frozen_modules/…   <- Modules/getpath.c
    门：>= 199 份编得出 —— 过
    ```

    **剩下那 2 份不是我们的欠账**（都要 `make regen-frozen` 先生成头，见第 17 条），
    而且 **199 份里一条警告都没有**。

    分母是 **201 份**而不是从前那 173 份：`Modules/` 那张名单改成**照
    `Modules/Setup.bootstrap.in` 读**（CPython 自己写的"哪些模块静态编进解释器"，
    37 份，含 `_io/*.c` / `_sre/sre.c` / `posixmodule.c` / `signalmodule.c` …），
    `Parser/` 也**连子目录一起扫**（`lexer/` 与 `tokenizer/` 那十份）。
    从前那 19 份是我手挑的 —— 选得不算错，但**没有来由**；现在换棵树自己跟着变。

    分母的口径是**本机该编的翻译单元**（`scope.js` 的 `NOT_TU` / `OTHER_PLATFORM`）：
    `Python/bytecodes.c` 那两份是 `Tools/cases_generator` 的输入，`Makefile` 从不编它们
    （`Makefile.pre.in:2101` 起那一串 `regen-cases`）；`dynload_*.c` 是 `DYNLOADFILE`
    挑一份（`configure.ac:5454`，darwin 挑 `dynload_shlib.c`）、`emscripten_*.c` 只在
    emscripten 上进 `PLATFORM_OBJS`（`configure.ac:5433`）。把它们算进"编不出"是口径错 ——
    **它们压根不该进分母**。

    几处口径写在这儿：
    - **门是 `--min`**（缺省 199，像 `tests/c/native-gen.js` 的 `MIN_OK`）：少于它 exit 1。
    - **我们站在构建系统的位置上**，所以它按文件给的开关我们也要给：`scope.js` 的
      `perFileDefs` 现在有一条 —— `Python/dynload_shlib.c` 要 `-DSOABI`
      （`Makefile.pre.in:1922`）。值照 `configure.ac:6742` 算：`cpython-` + 版本（从参考树的
      `Include/patchlevel.h` **读**）+ `ABIFLAGS`（空）+ 平台（我们不定义 `SOABI_PLATFORM`，
      所以没有后缀）。
    - **`HAVE_DYNAMIC_LOADING` 从前是错的**：它落进了 `gen-pyconf.js` 的"有没有这个函数"
      那一族、被静悄悄答成"没有"。它不是函数，是决定（`configure.ac:5473`：`DYNLOADFILE`
      不是 stub 就定义它，而有 `dlopen` 的机器上挑的是 `dynload_shlib.o`）。答错的代价是
      **我们少编了一整块代码**：`Python/import.c` 里动态装载那条路整段跳掉、
      `dynload_shlib.c` 连 `dl_funcptr` 都看不见。这一格是第 13 条那把尺子逼出来的。
    - 量的是 `Objects` + `Python` + `Parser` 三棵 **加上 `Modules/` 那张名单**（19 份
      "核心扩展模块"：`_abc` / `_bisect` / `_codecs` / `_collections` / `_datetime` /
      `_functools` / `_heapq` / `_operator` / `_random` / `_stat` / `_typing` / `_weakref` /
      `atexit` / `cmath` / `errno` / `itertools` / `math` / `symtable` / `time`）——
      它们**19 份全部干净出 `.o`、一条警告都没有**，而且量过：一个新宏都不带。
      整棵 `Modules/`（101 份）要 `--all-modules`，那得先把那 13 个宏一格一格决定（见下）。
    - **按族印**，因为「编不出 21 份」没有意义，「11 份卡在同一句 `__asm__`」才有。
    - 三档分开数：`ok`（一条诊断都没有）/ `warn`（出了 `.o` 但有警告 —— 那多半是
      "链接那天才炸"的隐式声明）/ `fail`。位计数那一刀之后**只剩 1 条警告**，
      而它是 emscripten 专有的内建（我们不出 wasm，不用管）。
    - `pyconfig.h` 缺了就现调 `gen-pyconf.js` 探一份，落 `.omni-cache/py-rt/inc` ——
      **参考树一个字节不写**。`--extra` 必须带上 `Include` 整棵：漏了它，线程那几格
      （`HAVE_PTHREAD_H` …）不进名单，探出来的配置少 17 条，于是**每一份**都报
      `#error "Require native threads"`（量到过，50 份全红，而看着像"前端坏了"）。
    - `Python/` 整棵带进来的七个宏这一刀照 `configure.ac` 一格一格决定了：
      `PY_COERCE_C_LOCALE` = 1（缺省 yes，是语义：PEP 538）、
      `PTHREAD_KEY_T_IS_COMPATIBLE_WITH_INT` 与 `PTHREAD_SYSTEM_SCHED_SUPPORTED`
      **真探**（前者两问：宽度一样 + `k * 1` 编得过；后者真编真跑一个 system 域的线程）、
      `USE_COMPUTED_GOTOS` 不定义（缺省两条 `AC_DEFINE` 都不走，让 CPython 自己按编译器挑
      —— 记一笔：它挑"开"要 `&&label` 与 `goto *p`，那是编 `ceval.c` 那天的问题）、
      `SOABI_PLATFORM` / `ALT_SOABI` / `ANDROID_API_LEVEL` 不定义（构建系统或安卓专有）。
    - **`Modules/` 扩面的第一道门量出来了**：那一棵（本机这份 CPython 下 **101 份 `.c`**）
      带进 **13 个**还没决定的宏，而它们的性质一眼就看得出来 ——
      `PY_SQLITE_*`（两个）、`PY_SSL_DEFAULT_CIPHER*`（两个）、`WITH_EDITLINE`、
      `WITH_DECIMAL_CONTEXTVAR`、`ENABLE_IPV6`、`POSIX_SEMAPHORES_NOT_ENABLED`、
      `MAJOR_IN_MKDEV` / `MAJOR_IN_SYSMACROS`、`GETPGRP_HAVE_ARG`、`HAVE__GETPTY`、
      `WITH_NEXT_FRAMEWORK`。**几乎全是"要不要借那个第三方库 / 可选模块"的决定**，
      不是编译器的活。所以下一刀不是"整棵 `Modules/`"，而是**按名单借那几份核心的**
      （`_collectionsmodule.c` / `itertoolsmodule.c` 这一类，先量它们各自要几个宏）。
    - 这一格顺手把上面第 10 条那张手工表**更正**了：**142 而不是 133** ——
      差的那九份是手工探的那份 pyconfig 少了格子（`fileutils.c` 与 `sysmodule.c` 从前报
      `F_GETFD` / `O_WRONLY` 看不见，那不是我们缺语法，是配置少探了 `HAVE_FCNTL_H` 一族）。
      **能自动回归的口径只有这一条**；第 10 条留着当那一刻的快照。

12. **内联汇编那一格：一张显式的白名单，不是通用内联汇编**（`tccgen.js` 的 `ASM_KNOWN`）。

    唯一剩下的真欠账是 CPython 的 `_Py_get_machine_stack_pointer`
    （`Include/internal/pycore_pystate.h:317`）里那一句 `__asm__ ("mov %0, sp" : "=r" (result))`
    —— 它卡住 11 份 `.c`（`Objects/` 六份、`Python/` 四份、`Parser/parser.c`），
    而链 libpython 一份都少不了。

    排掉的两条歧路：**不做**通用内联汇编（那要自带汇编器，ADR-0017 第九到十一步）、
    **不做**隐式的模板匹配 hack。做的是一张**显式的小表**，每一条写清：模板原文、
    GNU 语义下它做什么、我们拿什么等价物顶上、凭什么说等价。表以外一律照旧报
    `第八刀：非空的 __asm__ 模板还没到`（边界不动，`gen-bad/asm-tmpl`）。
    这与把 `__atomic_*` 落成普通读写是同一种"带账的等价实现"。

    第一条（也是目前唯一一条）是"读机器栈指针"，落成**取一格匿名局部量的地址**：
    - 凭什么等价：CPython 自己的 `#else` 分支写的就是 `char here; result = (uintptr_t)&here;`
      （同一个函数，`:328-331`）—— **它自己认这是同一件事的可移植写法**；而这个值的唯一
      用途是与另一次同样的取值相减、量栈用了多深（`_Py_RecursionLimit_GetMargin`），
      那个差值我们给得同样对。
    - 为什么不落成一条 MIR 新算子：**"读 SP"这个语义在 JS 腿上根本不存在**。
    - 收的形状只有「一个输出、没有输入、约束 `=r`」；别的形状是边界
      （`gen-bad/asm-sp-shape`）。顺带把 `asmOperands` 从"只报错"改成认得
      `"约束" (左值)`（只在模板命中白名单时才去读）。
    - 判据 `tests/c/gnu/03-asm-read-sp.c`，尺子是 clang（tcc 也收不了这一句）：
      **问关系不问数值** —— clang 那份真读 SP、我们那份给局部量地址，两个数本来就不同，
      能比的是"非零"与"递归深一层拿到的地址更低"。
    - 量出来的：`npm run py:sweep` 的门 **161 -> 172**，那 11 份一份不剩，
      而剩下的 10 份里**我们自己的欠账是 0**。

    表里另外记着 `__x86_64__` 那一支（CPython 写的是 `"{movq %%rsp, %0"`，那个 `{` 是
    它源码里就有的），照原样收着但没判据 —— 考它 clang 编不过，这一组的尺子就没了。

13. **第二把尺子：编出来的 `.o` 与 clang 的比外部符号**（`ext/python/rt/symbols.js`，
    `npm run py:symbols`）。

    `sweep.js` 只回答**编得出**。少发一个函数、把 `static` 发成外部、把一个 `extern` 的
    名字拼错 —— `.o` 照样出得来，而那些要到**链接那天**才炸。这一份把那一天提前：
    同一份 `.c`、同一套开关，我们与 clang 各出一份 `.o`，两份的外部符号集必须一样
    （`nm -g -U` 定义出来的、`nm -g -u` 要别人给的，逐个对）。

    ```
    $ npm run py:symbols
    共 173 份：**符号对上 167**、已知差异 5、对不上 0、跳过 1（103s）
    ```

    - clang 那侧的开关要与我们**语义对齐**才叫量同一件事：`-D_FORTIFY_SOURCE=0`
      （我们那份 `tccdefs.js` 就是 0，不然 clang 发的是 `__memcpy_chk` 一族）、
      `-fno-stack-protector`（我们不发栈保护）。
    - 跳过的那 1 份就是 `sweep` 里编不出的 `frozen.c`。
    - `SOFT`：两边都可以有也可以没有的几族 —— 定长小块 `memcpy/memset/bzero`（摊开或发
      调用都合规）、`copysign`/`fma` 这类 clang 当内建摊成一条指令的 libm 函数、
      `__chkstk_darwin`（clang 给大帧发的栈探针）、`__isnan` 一族
      （`<math.h>:159` 看 `__FINITE_MATH_ONLY__`，我们是 1 所以走发调用那支）。
    - `KNOWN_BAD`：**按文件记的五笔已知差异**，每笔写清"差的是哪一段代码、为什么"。
      修好了还留着，脚本会喊（棘轮不许空转）。五笔里三个根因：
      1. **`_Thread_local` 当普通全局**（`import.c` / `pystate.c` 的 `__tlv_bootstrap`）——
         与 `__atomic_*` 落成普通读写同一笔账：这条链一个线程都不起。
      2. **macOS 可用性那一族的编译期问答**我们没有 —— `__has_builtin(__builtin_available)`
         （`pytime.c`：clang 编"带运行期回退"的两支，我们只编 `clock_gettime` 那支）与
         `__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__`（`pylifecycle.c`：
         `HAS_APPLE_SYSTEM_LOG` 因此是 0，`os_log` 那一块我们没编。clang 给 270000）。
         **补那格版本宏不够**（试过）：下一道门是 `os/log.h:35` 的
         `#if !__has_builtin(__builtin_os_log_format)` 自己 `#error` —— 这一笔的真价钱是
         那个内建（编译期把格式串与实参打成一个缓冲区），不是版本宏。
      3. **`realpath` 的 `$DARWIN_EXTSN` 改名**我们故意不改（量过：本机两个符号给同一个答案）。
    - **这把尺子第一次跑就抓出一格配置错**：`import.c` 从前多要一个
      `PyModule_FromSlotsAndSpec` —— 顺着查下去是 `HAVE_DYNAMIC_LOADING` 被当成函数探针、
      答成了"没有"，于是**我们少编了一整块代码**（见第 11 条那一段）。
      "编得出"那把尺子对此一无所知：少编一块，`.o` 照样干干净净地出来。

14. **`Modules/` 整棵量了一遍**（`npm run py:sweep -- --all-modules`）。

    先给那 13 个还没决定的宏一格一格写了决定（`gen-pyconf.js` 的 `DECIDED`）：四格是**真探针**
    （照 `configure.ac` 的程序原样跑：IPv6 真建一个 `AF_INET6` socket、`getpgrp(0)` 编不编得过、
    `major`/`minor` 从哪个头来的三选一、POSIX 信号量真 `sem_open` 一次），
    九格是**借不借那个第三方库**的决定（sqlite / OpenSSL / libedit / Tk…，一律不借），
    外加 `WITH_DECIMAL_CONTEXTVAR` 照 configure 缺省给 1（那是语义，不是"借不借"）。

    ```
    $ npm run py:sweep -- --all-modules
    共 255 份：**编出 .o 241**（干净 241 + 带警告 0）、编不出 14（108s）
    ```

    编不出那 14 份，按**根因**（不是按诊断）：
    - **7 份是"那个库我们不借"**：`_dbmmodule`(ndbm) / `_gdbmmodule`(gdbm) /
      `_lzmamodule`(lzma) / `_ssl` + `_hashopenssl`(OpenSSL) / `_tkinter` + `tkappinit`(X11+Tk)。
    - **2 份是别的平台**：`_winapi`(windows.h) / `overlapped`(winsock2.h)。
    - **1 份压根不该在核心构建里编**：`_testcapimodule.c` 自己 `#error`
      （"_testcapi must test the public Python C API"）。
    - **2 份要构建系统先跑一步**：`frozen.c` 与 `Modules/getpath.c`（都要生成的 frozen 头）。
    - **2 份是我们的欠账**（下一刀）：`_scproxy.c` 报 `'}' expected (got '__attribute__')`、
      `socketmodule.c` 报 `bad preprocessor expression: #if ! 0 || ! 0 ( 0 )`
      （那是 `TargetConditionals.h` 里 clang 的 `__is_target_os(...)` —— 与 tcc 同一句诊断）。

    那两份的账当场就清了两格（第 15 条）。

    路上量出两格**配置错**，两格都是"答案看着合理、其实答错了"：
    - **摘 HACL\* 那六份**（`md5module` / `sha1` / `sha2` / `sha3` / `blake2` / `hmac`）报
      `krml/internal/types.h` 不在。那**不是"不借第三方库"** —— HACL\* 就 vendored 在借来的
      那棵树里（`Modules/_hacl/include`），少的只是 `Makefile` 给它们加的那一格 `-I`
      （`LIBHACL_CFLAGS`）。补进 `scope.js` 的 `perFileFlags` 之后六份全出 `.o`。
    - **`HAVE_FDATASYNC` 从前答"有"，真 CPython 答"没有"**。根因是 CPython 有**两种**
      "有没有这个函数"的检查，而宏名上看不出是哪一种：`AC_CHECK_FUNCS` 问"链得上吗"，
      `PY_CHECK_FUNC`（`configure.ac:57-70`）问"**这几份头声明了它吗**"（程序体是
      `void *x = 函数名;`）。macOS 上 `fdatasync` 真有这个符号、却没在 `<unistd.h>` 里声明，
      于是两种问法答案相反。答错的代价：`posixmodule.c:4478` 去拿它的地址、报 undeclared ——
      **clang 在同一份配置下一字不差地报同一句**，所以那不是前端的欠账。
      修法是**照 `configure.ac` 的原文来**：把每一处 `PY_CHECK_FUNC` 的名字/头/宏名解析出来，
      按它的问法探（换棵树自己跟着变）。量完拿**本机那份真 python 的 `pyconfig.h`** 对了六格
      （`CHROOT`/`CTERMID_R`/`FDATASYNC`/`FSYNC`/`GETPAGESIZE`/`KQUEUE`），一格不差。

    顺手记一条**下一把尺子的点子，已经试过一次、抓到东西了**：本机装着的真 python 的
    `pyconfig.h` 是个**免费的 oracle**。拿它与我们探出来的那份逐格对（只对两份都有的名字）：

    ```
    两份都有的宏 513、定义与否一致 450、不一致 63
    ```

    63 格里大半是**我们自己的决定**（不借 curses / libffi / …，那几族一看就明白），
    剩下的是**真探针缺口**，而且都是"`HAVE_X` 这个名字不一定是个函数"：
    - `HAVE_ADDRINFO` / `HAVE_SOCKADDR_STORAGE` —— 那是**结构体**检查
      （`configure.ac:6244` / `:6252` 的 `AC_COMPILE_IFELSE`：`struct addrinfo a;` 编得过吗）。
      我们那一族按"链得上一个叫 addrinfo 的函数吗"问，自然答"没有" ——
      代价是 `Modules/addrinfo.h:129` 自己又定义一遍 `struct addrinfo`，
      于是 `socketmodule.c` 报 `redefinition of 'struct addrinfo'`。
    - `HAVE_STRUCT_*` 那一族（`AC_CHECK_MEMBERS`，如 `HAVE_DIRENT_D_TYPE`）—— 问的是
      "这个结构体有这个成员吗"，同样不是函数。
    - `HAVE_DEVICE_MACROS` / `HAVE_MAKEDEV` / `HAVE_GCC_UINT128_T` /
      `HAVE_COMPUTED_GOTOS` / `HAVE_DEV_PTMX` / `HAVE_BROKEN_SEM_GETVALUE` ——
      各自有自己的程序要跑。
    - 两格是**版本差**（那份 pyconfig 出自 3.14 与更老的 SDK）：`HAVE_DUP3`、
      `HAVE_DECL_TZNAME`。对账时要把这类排掉，别当 bug 修。

    **下一刀就是这个**：把这把尺子写成脚本（`ext/python/rt/pyconf-diff.js` 一类），
    按族给差异标上"我们的决定 / 真缺口 / 版本差"，门定在"真缺口 = 0"。

    **那 20 多格真缺口当场补完了**（第 16 条）：非库那族的差从 35 格降到 **12 格**，
    而 12 格全都解释得清 —— 8 格是我们自己的决定、4 格是版本/SDK 差，**真缺口 0**。

15. **那两格前端欠账清了**（`Modules/` 那 14 份里我们自己的两份）。

    - **枚举常量上的 `__attribute__`**（`tccgen.js` 的 `enumDecl`）：名字之后读掉属性。
      gcc/clang 收（C23 把它写进标准了），**tcc 不收**（`tccgen.c:4520-4528` 名字之后直接看
      `=`），所以判据在 `tests/c/gnu/04-enum-attr.c`（尺子 clang）——
      考的是**值**：带属性那一格与不带的一样参与"上一格 + 1"，两处属性连着写也认。
      逼出它的是 macOS 的 `Security.framework/Headers/SecBase.h:329`
      （`errSecDskFull __attribute__((deprecated(…))) = errSecDiskFull,`）。`_scproxy.c` 出 `.o` 了。
    - **`__has_extension` 补进 `COMPILE_DEFS`**（回 0，与 `__has_builtin` 一族一致）。
      tcc 的 `include/tccdefs.h:152-154` 只有三个探测宏，而 `TargetConditionals.h:147` 写的是
      `#if !defined(__has_extension) || !__has_extension(define_target_os_macros)` ——
      `||` 在 `#if` 里**不短路语法**：右边没定义时变成 `0 (0)`，整行是语法错（tcc 也一样报）。
      放 `COMPILE_DEFS` 而不是 `predefs`，`tcc -dM` 那组判据才继续逐行相同。
      `socketmodule.c` 于是往下走了一步 —— 下一道门是上面那格 `HAVE_ADDRINFO`。

16. **那把 oracle 对出来的缺口补完了：`HAVE_X` 这个名字不一定是个函数**
    （`gen-pyconf.js`，二十多格）。

    分四族补：
    - **`HAVE_STRUCT_<类型>_<成员>`**（`AC_CHECK_MEMBERS`，九格）：机械可推 ——
      名字里哪个下划线是分界看不出来，所以**每种切法都试一遍**（与 `headerCandidates`
      同一手法）。从前它们全落进"链得上一个叫 `struct_stat_st_blksize` 的函数吗"、
      一律答"没有" —— 代价是 `os.stat()` 那几格属性在借来的运行时里会**静悄悄少掉**。
    - **类型在不在**（三格）：`HAVE_ADDRINFO` / `HAVE_SOCKADDR_STORAGE` / `HAVE_SSIZE_T`。
      答错 `HAVE_ADDRINFO` 的代价看得见：`Modules/addrinfo.h:129` 自己又定义一遍
      `struct addrinfo`，`socketmodule.c` 报 `redefinition of 'struct addrinfo'`。
    - **各有自己的程序**（十格）：`makedev`/`HAVE_DEVICE_MACROS`（宏不是函数）、
      `/dev/ptmx` 在不在（`AC_CHECK_FILE` —— 这一格连编译器都不用）、
      `struct dirent.d_type`、`struct sockaddr.sa_len`、`siginfo_t.si_band`
      （typedef，所以宏名里没有 `STRUCT`）、`st_mtimespec.tv_nsec`、
      两个常量（`MAXLOGNAME` / `UT_NAMESIZE`）、`tzset` 真跑一遍、
      `sem_getvalue` 坏不坏（名字是反的：坏才定义）。
    - **问的是编译器、不是机器**（两格，是决定不是探针）：`HAVE_GCC_UINT128_T` 与
      `HAVE_COMPUTED_GOTOS`。探针用的是 clang，clang 两样都有；**我们没有**
      （`__uint128_t` 在 `tccdefs.js` 里只是个占位 struct、`&&label`/`goto *p` 不支持）。
      定义了它们 CPython 就会走那两条我们编不出来的路。**从前答对是碰巧** ——
      那一族按"链得上吗"问、答了"没有"。这条分界值得单记一笔：
      **探针只回答"这台机器怎样"，凡是问"这台编译器怎样"的都得我们自己答。**

    量出来的：
    - 与真 pyconfig 的非库差异 **35 -> 12**，12 格全解释得清（8 格我们的决定 +
      4 格版本/SDK 差：`HAVE_DUP3`/`HAVE_PIPE2`/`HAVE_DECL_TZNAME`/`HAVE_SYS_DIR_H`），
      **真缺口 0**。
    - `--all-modules`：**255 份里 243 编出 .o**（242 干净 + 1 带警告）、编不出 12 ——
      `socketmodule.c` 出来了，而剩下 12 份里**我们自己的欠账是 0**
      （7 份"库不借"、2 份别的平台、1 份不该在核心构建里编、2 份要构建系统先跑）。
    - 那 1 条警告是 `socketmodule.c:9454` 的 `__builtin_constant_p` 隐式声明，
      当场补掉了：`COMPILE_DEFS` 里**一律答 0**（"不是编译期常量"）。tcc 有这个真内建
      （跟着常量折叠回 1），我们还没有 —— 但答 0 在语义上永远安全：用它的代码都是
      `__builtin_constant_p(x) ? 常量快路 : 普通路`，答 0 就是一律走普通那条。
      **于是 `--all-modules` 那一趟是 243 份全干净、一条警告都没有。**

17. **第三把尺子：把那堆 `.o` 真摞起来**（`ext/python/rt/link.js`，`npm run py:link`，**0.3s**）。

    前两把回答"编得出"与"编得对（接口层面）"。这一份回答第三问：**链接器还缺什么**。
    做法是**让真链接器说话** —— `clang -dynamiclib` 把那 199 份 `.o` 链一次；macOS 的
    链接器自己从 libSystem 解析 libc 那一族，所以**剩下的未定义符号就是我们还差的东西**。
    （不拿 `nm` 做集合减法：那种减法会把"libc 会给的"也算成缺口。）

    ```
    $ npm run py:link
    py-rt/link: 范围 201 份，手上有 199 份 .o
    ar: libomnipython.a —— 22.4M
    ld: 还缺 7 个符号（0.3s）
    有账的（等构建系统先跑一步）：
      Modules/config.c（1 个）：_PyImport_Inittab
      Modules/getpath.c（1 个）：_PyConfig_InitPathConfig
      Python/frozen.c（5 个）：_PyImport_Frozen{Modules,Aliases,Bootstrap,Stdlib,Test}
    门：没账的未定义符号 0 个 —— 过
    ```

    也就是说：**借来的那份运行时，除了三份构建系统产物给的 7 个符号，我们编得出、链得上。**
    那三份不是我们编不出来，是**它们的输入还没生成**：
    - `Python/frozen.c` / `Modules/getpath.c` 要 `Python/frozen_modules/*.h`
      （`make regen-frozen` —— 那一步要一个**能跑的 `_freeze_module`**，是个自举环）；
    - `Modules/config.c` **树里压根没有这份文件**（`makesetup` 按 `Setup` 生成内建模块表）。

    这把尺子当场逼出一个**分母漏洞**：`Parser/` 只扫了顶层，而 `PARSER_OBJS`
    （`Makefile.pre.in:428`）还有 `lexer/` 与 `tokenizer/` 那十份 —— 少了它们，
    `pegen.c` 一族引用的 21 个 `_PyTokenizer_*` / `_PyToken_*` 没有定义。
    "编得出"那把尺子看不见这种漏洞（每一份都编得出，只是**少量了十份**）。

    三把尺子现在的读数（都在 2 分钟以内，可以改完就跑）：
    - `py:sweep` 201 份里 **199** 编得出、**0 警告**
    - `py:symbols` **194** 份的外部符号与 clang 一模一样、5 笔按文件记账、没账的 0
    - `py:link` **199 份摞成 22.4M**，只缺那 7 个构建系统产物的符号

18. **借来的那份运行时真跑起来了**：我们编出来的 `_freeze_module` 跑通，出的 frozen 头
    与 clang 编的同一套**逐字节相同**。

    前三把尺子最远只到"链得上"。这一格是**第四问：跑起来对不对**。拿 CPython 自己的
    `Programs/_freeze_module.c` 当被试者（它是构建系统那一步要的工具：把一份 `.py` 编成
    字节码、摞成一个 `.h`）—— 它一进门就 `Py_InitializeFromInitConfig`，跑完要
    `PyParser` + `compile` + `ceval` + `marshal` 全都对。

    要凑齐的三份构建系统产物：`Modules/config.c` 照 `config.c.in` 现生成
    （新的 `ext/python/rt/gen-config.js`，模块名从 `Setup.bootstrap.in` 读 —— 与
    `py:sweep` 量哪几份 `.c` 同一张名单）、`Modules/getpath_noop.c`（CPython 自己给
    这一步用的空实现）、`_freeze_module.c` 自己（它在 `.c` 里定义那五个 frozen 符号，
    所以不必先有 `frozen.c` —— 那个自举环就是这么破的）。

    读数：**我们的 199 份 `.o` + 这三份，链出 21.5MB 的 `_freeze_module`，跑起来 exit 0**，
    出的 `.h` 与"clang 编的同一套 199 份 + 同样这三份"出的**逐字节相同**（两份输入都试了：
    一行赋值的、以及带 class / 默认参数 / 列表推导 / `__name__` 的）。

    **这一趟当场抓出两格 codegen 答错**（都是"编得出、链得上、跑起来错"那一档 ——
    前三把尺子一格都看不见）：

    - **复合字面量当声明的初始化式时，没点名的成员没归零**（`tccgen.js` 的 `initializer`）。
      `decl` 那儿的清零由 `braced` 管，而它判的是 `=` 后面第一个记号是不是 `{`；
      `T x = (T){ … }` 那一路是 `(`，于是整块都没清。
      出处 `Include/internal/pycore_initconfig.h:110` 的 `_PyPreCmdline_INIT`：
      三个 int 点了名、前两个成员 `PyWideStringList argv/xoptions` 一个都没点 ——
      于是 `_PyConfig_Read` 里那个 `precmdline` 的 items 是栈上的垃圾，一路活到
      `done:` 的 `_PyPreCmdline_Clear`，在那儿把垃圾指针当字符串数组 free。
      症状：崩在 `Python/initconfig.c:794` 的 `assert(list->items[i] != NULL)`。
      判据：`tests/c/gen/61-compound-literal.c` 末尾那一格（**先把栈写脏**再量，
      不然"看着是 0"只是那段栈本来干净）。

    - **类型还不完整时的 `extern` 声明，把别人的初值吃掉了**（`allocGlobal` 与封盘那步）。
      `PyAPI_DATA(PyTypeObject) PyType_Type;` 在 `Include/object.h` 里，那一刻
      `struct _typeobject` 还没定义 —— `typeSize` 回 0，于是一串这样的声明**全落在
      同一个暂存地址上**；封盘那步又按"现在这个类型有多大"（432 字节）去把没认领的字节
      丢掉，把后面那些全局量的初值一起丢了。
      症状：`Py_None` 的 refcnt 是 0（该是 `3<<30`），崩在 `Objects/object.c:3472` 的
      `assert(_Py_IsImmortal(constants[i]))`；修了这一半又露出第二半 ——
      同一个名字后来真成了定义（`PyType_Type` 那份四百多字节的初始化式）时要**重新划一块**，
      不然它的初值写到别人的字节上，ld 报 `pointer not aligned in '_PyType_Type'+0x192`。
      两处都修：`allocGlobal` 记下**真留了多少**（`allocSize`，不完整的 extern 至少一格）、
      封盘按 `allocSize` 丢、类型补全且不够大时重划（native 那条腿总能挪 —— 代码里取地址
      走 `GADDR`、初值里的地址走 `pendingFix`，两处都不认那个暂存地址）。
      判据：`tests/c/gen/95-extern-incomplete-data.c`。

    这两格都是**"自己编出来那份真跑一趟"**才抓得住的 —— 量过：两个用例在修之前
    native 那条腿都 FAIL、修之后与 `tcc -run` 逐字节相同。

    **还差一步到 201/201**：`Python/frozen.c` 与 `Modules/getpath.c` 要
    `Python/frozen_modules/*.h`（`make regen-frozen` 那一步）。现在手上已经有一个
    **能跑的 `_freeze_module`**，所以那一步是"拿它把那几十份标准库 `.py` 冻出来"，
    不再是自举环。参考树只读，所以那些头落 `.omni-cache/py-rt/gen/` 再用 `-I` 指过去。

19. **第四把尺子进仓库了，而且那最后两份也编出来了 —— 201/201、链接 0 缺口**
    （`ext/python/rt/freeze.js`，`npm run py:freeze`，**8s**；`--oracle` 再多一步比对）。

    这一份把上面那一趟变成**能回归的尺子**，一趟四问连着答：
    1. 三份构建系统产物我们自己站着做（`config.c` 现生成、`getpath_noop.c`、`_freeze_module.c`）；
    2. 与那 199 份链出 `_freeze_module`；
    3. **真跑**：冻哪几份、模块名与源码路径**照 `Makefile.pre.in` 里那几条规则读**
       （`:1728` 起，26 条），头落 `.omni-cache/py-rt/gen/Python/frozen_modules/`；
    4. 顺着往下：`Python/frozen.c` 与 `Modules/getpath.c` 现在**编得出**了
       （`getpath.c` 另要七格 `-D`，照 `Makefile.pre.in:1885-1891` 那条规则给 ——
       `PREFIX` / `PLATLIBDIR` 是 configure 缺省值、`VERSION` 从 `patchlevel.h` 读）。

    `--oracle` 那一步的判据最硬：**26 份头与"clang 编的同一套 199 份"出的逐字节相同**
    —— 不只是"跑起来不崩"，是**编出来的字节码一模一样**。
    （clang 那一套 `.o` 是 `py:symbols` 顺手缓在 `sym/` 里的，所以这一步不另花时间。）

    四把尺子现在的读数（都在 2 分钟以内，改完就能跑）：
    - `py:sweep` **201 份里 201 编得出、0 警告、0 编不出**（`--min` 跟着"冻没冻过"走：
      冻过是 201，刚 clone 是 199 —— 定成一个固定的数必有一边在骗人）
    - `py:symbols` **194** 份的外部符号与 clang 一模一样、5 笔按文件记账、没账的 0
    - `py:link` **202 份 .o 摞成 21.1M 的 dylib，一个未定义符号都没有**
      （多出来那一份是我们自己生成的 `Modules/config.c`）
    - `py:freeze` **26/26 份 frozen 头冻得出、与 clang 编的同一套逐字节相同**，
      下游那两份也编得出

    也就是说：**借来的那份 CPython 运行时，我们自己那台 C 前端从头编到尾、链得完整、
    跑起来与 clang 编的同一套给出一样的字节。** 剩下的是语言层怎么用它（§一之二 第 0 刀）。

20. **整个解释器也跑起来了**（`python -c "print(...)"`），但要 `ulimit -s 65520` ——
    卡点已经量清楚，在**后端**，不在 C 前端。

    做法：那 202 份 `.o` 再加 `Programs/python.c`（`Py_BytesMain`）链成 22M 的可执行，
    `PYTHONHOME` 指到一份 `lib/python3.16 -> <参考树>/Lib` 的软链上：

    ```
    $ (ulimit -s 65520 && PYTHONHOME=/tmp/ic/home ./ourpython \
         -c "import sys; print('ours', sys.version.split()[0]); print(sum(i*i for i in range(10)))")
    ours 3.16.0a0
    285
    ```

    也就是说 **importlib 的整套自举、encodings、site、sys 模块、字节码解释器全跑通了**。
    默认 8MB 栈上崩在 `_PyEval_EvalFrameDefault+16` 的第一条 `str`（栈踩穿），原因是
    **那个函数的帧要 0x6e1e0 ≈ 451KB**（clang 给的是几百字节）。

    量清楚了帧是谁吃掉的（这一格值得记住，别再猜）：
    - C 前端自己算的帧（`frameAlloc` 那一路：数组、聚合、被取地址的标量）只有 **304 字节**；
    - 451KB 是**后端给每个 MIR 值一个栈位**（见 `gvarLval` 的注："这一层的两个后端把
      每个值都落在栈位上"）。`generated_cases.c.h` 展开出几千个 case、几万个值，
      于是每个值 8 字节就是几百 KB。
    - 所以下一刀在后端：**按活跃区间复用栈位**（或至少让同一个块里死掉的值让位）。
      试过在前端做"出块回收帧"（`popScope` 把 `frameOff` 拨回去）——
      前端那 304 字节确实更小了，但 451KB 一格没动，所以那一刀**撤回了**，
      留给后端那一刀一起做（判据现成：这一格的 `sub sp` 要从 0x6e1e0 掉到几 KB）。

    **另一格记在账上的事**（不是缺陷，是口径）：把"clang 全套 + 我们一份"混起来链时，
    我们那一份若读 `_Py_thread_local` 的变量（`_Py_tss_tstate`）就会拿错地址 ——
    我们现在把 TLS 当**普通全局**编（`symbols.js` 的 `KNOWN_BAD` 里记着那笔
    `__tlv_bootstrap`）。所以混链的结果只能用来定位，不能当"跑得对"的判据；
    **全用我们自己编的那一套**才是。（真正的多线程也要等这一格补上。）

21. **那 451KB 的帧修了 —— 默认 8MB 栈上，我们自己编出来的 python 跑得过真脚本了。**

    修的地方在**后端**，不在 C 前端：`regalloc.js` 新出两张"栈位复用表"，
    两条腿（arm64 / x86_64）照它算偏移。
    - `fn.valHome`：**值**的栈位按活跃区间复用。区间与寄存器那一套**共用同一份**
      （`[定义, 最后一次使用]`，循环那一刀已经延长过），栈位这一侧颜色没有上限，
      所以一遍线性扫描、不必抢占。
    - `fn.slotHome`：**槽位**（C 的局部变量）同理，区间算法与"槽位提升"那一格同一条
      （`[第一次访问, 最后一次访问]` + 循环撑开）。
    - `SETJMP` 那一族整份不碰：`longjmp` 把控制送回更早的 pc，"区间按 pc 线性"这条前提
      不成立（槽位提升那一格出于同一个理由也是整份退出）。
    - **两个后端自己叫** `assignStackHomes(f)`：C 那条路一遍过、不跑优化管线，
      而这件事与优化开不开无关 —— 它是"跑不跑得起来"。

    `_PyEval_EvalFrameDefault`（52438 条 MIR、3900 个槽）的帧：
    **464KB -> 33KB**（值那一侧 52438 格 -> 234 格）。于是：

    ```
    $ PYTHONHOME=…/home ./ourpython smoke.py      # 默认 8MB 栈，没有 ulimit
    fib(20) = 6765
    pts = [P(0,1), P(1,2), P(2,3)]
    json = {"a": "x", "b": [1, 2.5, null, true]}
    re = [('a', '1'), ('bb', '22'), ('ccc', '333')]
    counter = [('a', 5), ('b', 2), ('r', 2)]
    deep(200) = 200
    caught: division by zero
    …
    ```

    **与 clang 编的同一套逐行相同**（json / re / collections / class / f-string /
    推导式 / 生成器 / 异常 / 递归 200 层都在里头）。

    判据：`tests/mir/stackhome.js`（新，进了 `tests/all.js`）——"用完就死的 502 条只要
    2 格"、"活到最后的 64 个一格都不许省"、"循环里那一格不许与循环外的同格"、
    "第二遍不重算"。行为那一侧由 `tests/c` 那 300 份真跑的用例兜住
    （339 过 0 败）、两条腿的编码对账各自照旧（arm64 207+88、x86_64 188+90）。

    **还欠一格**（下一刀）：那 33KB 里 31KB 是**槽位**——`_PyEval_EvalFrameDefault`
    的 3900 个槽全被解释器那个大 `LOOP` 撑成"整段活着"，一格都共用不了。真正的出路是
    **C 前端按块作用域复用槽位**（`declareLocal` 那一路：出了 `}` 的名字再也访问不到，
    所以那个槽可以给下一个同类型的局部量）。那一刀落下去这个函数的帧该掉到 2KB 上下。

22. **槽位也按块作用域复用了（C 前端）—— 帧 33KB -> 24KB；帧上那一半试了两回都退回来**。

    上面那一格的下一刀：`declareLocal` 里那个 `f.slot(name, …)` 改成**先问空闲表**
    （按 MIR 类型分桶），`popScope` 把这一层领的槽还回去。判据就一条 C 的规矩：
    **出了 `}` 的名字再也访问不到**，所以那个槽可以给下一个同类型的局部量。
    语句表达式那一层例外（`noReclaim`）—— `({ int t = f(); t; })` 的值就住在块里那个
    局部量上，交出去之后外头还要读一次。

    读数：`_PyEval_EvalFrameDefault` 的帧 **33120 -> 24048 字节**（一路下来
    464032 -> 24048，**19 倍**）。

    **帧上那一半（`frameAlloc` 出块回收）试了两回，两回都退回来了** —— 这一条记在
    `frameOff` 的注上，免得再试第三遍：拨回游标之后，我们自己编出来的 `_freeze_module`
    冻大一点的 `.py`（`os` / `_collections_abc` / `importlib._bootstrap_external` /
    `_pybuiltins`）就崩在 `_PyCfg_OptimizedCfgToInstructionSequence` 收场那条 `ldp`
    上（读到 `0xffffffffffffffff` —— 调用者保存的 x29/x30 被写坏了，
    也就是**有人把帧上的地址活过了它那个块**）。同样的回收在**槽位**那一侧是绿的，
    区别就是槽位没有地址。要再试，先把"谁的地址活过了块"找出来。

    这一趟还顺手修了第四把尺子的一处**会骗人的地方**：`freeze.js` 从前不删旧文件，
    于是这一趟崩了、上一趟的头还躺着，"与 clang 逐字节相同"就拿旧文件去比、报一片绿
    （量到过一次）。现在两侧都先 `rmSync`。

    判据（这一刀）：`tests/c` 339 过 0 败、`native-gen` 93 过、arm64 207+88、
    x86_64 188+90、`selfc` 6 过、`lower` 325 过、`go` 46 过、`mir` 51 过、
    `py:sweep` 201/201、`py:freeze` 26/26 + oracle 26/26、`py:link` 0 缺口，
    以及**我们自己编出来的 python 跑那份 smoke 与 clang 编的逐行相同**。

23. **第四把尺子进了轴表；顺手把"该不该把借来的 dtoa 接到 `str(float)` 上"这笔账量清了**。

    (a) `py:freeze` 原来只在 `package.json` 的 npm script 里，`tests/all.js` 的
    `SUITES` 里没有它 —— 于是四把尺子里**唯一量"跑得对"的那一把从来不会被自动跑到**。
    现在有 `tests/python/freeze.js`（薄封装，真活还在 `ext/python/rt/freeze.js`）：
    参考树不在 / 没 clang / `obj/` 没被 `py:sweep` 预热过就**跳过而不是红**
    （那把尺子当命令行工具用时对"缓存没预热"该 exit 1，当轴用时不该把它记成
    "编译器坏了"）。`--oracle` 那一路不进轴表：它要 `py:symbols` 缓下来的 199 份
    clang `.o`，预热成本比这条轴自己大一个量级。读数：26/26 + 两份下游，**7.0s**。

    (b) `str(float)` 那一格**先量再决定**：`py_repr` 现在有三份实现
    （`host/pure.js` 的 `pyReprReal` / `prelude.js` 的 `$pyrepr_real` /
    `omni_fmt.c` 的 `omni_pyrepr_real`），本来打算用借来的 `Python/dtoa.c` 把它们
    收成一份。量出来的账是：**三条腿（interp / js / c）在 200 个定死的位模式上与
    python3 逐字节相同**（新例子 `ext/python/examples/floatsweep.py`），
    `pyReprReal` 对 `tests/python/rt.js` 那批 2032 个数也全对。所以接过去
    **买不到正确性**，只买"一件事一份实现" —— 那笔钱（`PyObject *` 打通到底 vs
    边界转换、整份运行时进产物）该花在别处（大整数、`Modules/` 那些库函数）。
    这一格不是"先不做"，是**账已经量清了**：谁要再提这一刀，先推翻这 200 + 2032 个数。

24. **第五格判据：我们自己编出来的代码把借来的运行时当库调，四格与 python3 逐字节相同**
    （`ext/python/rt/embed.js` + `embed-probe.c`，`npm run py:embed`，**1.5s**）。

    第四把尺子量的是**别人写的 main**（CPython 的 `_freeze_module`）；这一格量的是
    **语言层要走的那条路** —— `.py` → 我们的 IR → C 之后发出来的就是"建对象、调方法、
    取回串"。所以先拿一份手写的 C 走通那条路（探针整份过**我们自己那台 C 前端**，
    链接器用 clang，`.o` 就是那 202 份）：

      * `'42'.zfill(5)` -> `00042`、`'42'.center(7,'*')` -> `***42**`（`unicodeobject.c`）；
      * `7 ** 80` -> 68 位十进制（`longobject.c` —— 我们自己的 int 是 64 位，**只能是它在答**）；
      * `repr(0.1 + 0.2)` -> `0.30000000000000004`（`dtoa.c`）。

    期望值不写死：同一句话交给本机 python3，逐字节比（口径与 `tests/python/run.js` 一条）。
    这一格与第四把尺子挂在同一条轴上（`tests/python/freeze.js`，两格连着跑，9.5s）——
    次序固定：`embed` 要 `freeze` 那一趟落下的 `Modules/config.c` 的 `.o`（`_PyImport_Inittab`）。

    **顺手量出来的两笔账**（第 0 刀 (a) 那个决定要用）：产物 **21.0M**；
    **`.o` 全进产物了，标准库还在磁盘上** —— 初始化要 `encodings`（纯 python），
    所以探针得拿 `-DPY_LIB_DIR` 指着参考树的 `Lib`。要把那一格也去掉，得把那几份 `.py`
    冻进来（`freeze.js` 已经有那套工具）。这两笔是"整份运行时进产物"的真实代价，
    不是猜的。

    **那个缺口当场堵上了 —— 门二：产物自带标准库**（`embed-frozen-probe.c`）。做法：
    `encodings` 那一族（`__init__` / `aliases` / `utf_8` / `ascii` / `latin_1`）用
    **我们自己编出来的** `_freeze_module` 冻成头，运行前把 `PyImport_FrozenModules` 换成
    "内置那张表 + 我们这五格"（`Include/cpython/import.h:30` 留给嵌入方的口子），
    `module_search_paths` **留空**、`cwd` 换到 `/`。读数：**跑得对，产物 21.1M**
    （比门一只多 0.1M）。所以"编出来的 python 程序不依赖磁盘上的标准库"这件事
    **是能做到的，已经量过**，不是设想。

    这一趟还堵了增量层一处**会骗人**的地方：`tests/all.js` 的轴指纹只看
    `tests/<轴>/` 与 `src/`，而 python 那三条轴的真活在 `ext/python/` 下
    （尺子脚本 + 例子）—— 量出来：加完 `examples/floatsweep.py` 之后 `python-run`
    的指纹**一个字节都没变**，也就是"改了判据照旧跳过、报上一趟绿"。
    `tests/lib/incr.js` 现在有一张小表 `AXIS_EXTRA`（轴名 -> 还要哈希哪几棵树）。

25. **门三：`omni build` 出来的产物调借来的运行时 —— 语言层那条路通了**（同一天）。

    前两问的链接命令是尺子自己拼的；这一问走的是**adapter 将来真正要走的那条路**：
    一份方言（`.sx`）→ `omni build` → 产物里带着借来的运行时。形状就三格，方言早就有：

    ```lisp
    (module
      (lib "<…>/libomnipython.a")         ; 那 202 份 .o + 我们那层薄皮 打成的静态库
      (cabi omni_py_boot i32 (ptr))        ; 薄皮：把 PyConfig 那一套收成一个 C ABI 函数
      (cabi PyRun_SimpleString i32 (ptr))  ; 借来的运行时自己的门
      (cabi omni_py_fini i32 ())
      (main
        (let rc int (ccall omni_py_boot (str "<…>/Lib")))
        (expr (ccall PyRun_SimpleString (str "print('42'.zfill(5)); print(7**80); print(repr(0.1+0.2))")))
        (expr (ccall omni_py_fini))))
    ```

    读数：**三行与本机 python3 逐字节相同**，产物 21.1M。所以 §二 第 0 刀 (c) 里
    "adapter 发'调借来的那一格'"这件事**在方言与后端那一侧已经通了** —— 剩下的是
    adapter 自己发这三格（`lower/sx.js` 的 `ccall/lib/cabi` 构造器都在），以及
    出串那一格（`(cabi …)` 的类型词里没有串，所以"回一个 python 串"要么走薄皮
    （像 `omni_pyfloat.c` 那样）、要么走 Builtin 那条路，像 `py_repr`）。

    **薄皮那一份是必须的，不是绕路**：`(cabi …)` 只有 i32/i64/ptr/f64/bool/void
    （`sexpr/lower.js` 的 `CABI_CORE`），`PyConfig` 那种结构过不去。
    `ext/python/rt/embed-boot.c` 23 行，自己也过我们那台 C 前端。

    **路上撞出两个真缺口，一个当场补了、一个记在这儿**：

      * 补了：**我们自己的链接器读不懂 macOS 那一套静态库**（BSD：`#1/<n>` 长名字、
        索引叫 `__.SYMDEF` 而且是小端）—— 原来只认 GNU/SysV，当场报"ar: 这个库没有
        符号索引"。`src/core/link/ar.js` 现在两套都读，判据是 `tests/c/ar-read.js`
        的 B 段（那一门**从前还不在轴表里**，现在进去了）。
      * 没补：**自带链接器这一路还走不通** —— `macho_exe.js` 吃的是 **ELF 那种 `.o`**
        （tcc 的老路：内部表示 ELF，输出才是 Mach-O），而 `obj/` 里那 202 份是 Mach-O
        的 `.o`（`c obj` 在 mac 上的默认格式）。所以门三现在挂着 `OMNI_CC=clang`。
        下一刀是让 `py:sweep` 能出一份 **ELF 格式**的 `.o`（`--format elf --os osx`），
        那之后"我们自己的前端 + 我们自己的链接器 + 借来的运行时"就是全自己的一条链。

26. **全自己那条链通了 —— 一个外部工具都没用**（`ext/python/rt/selflink.js`，
    `npm run py:selflink`，**11.8s**（`.o` 暖着）/ ~110s（现编））。

    上一条记的"下一刀"当场落了。三格都收回自己手里：

      * `.c` -> `.o`：**我们那台 C 前端**，`--format elf --os osx` —— 我们的链接器吃的是
        **ELF 那种 `.o`**（tcc 老路：内部表示 ELF，输出才是 Mach-O）。203 份全编得出。
      * `.o` -> `.a`：**我们自己打的**（`src/core/link/ar.js` 新增 `writeArchive`，
        出 GNU/SysV 那一套：`/` 索引 + `//` 长名字表）。**这一格没有系统工具可用** ——
        macOS 的 `ar` 只认 Mach-O 成员，喂它 ELF 的 `.o` 它一声警告
        （`not a mach-o file`）就把成员全丢掉，出一份 **96 字节的空库**（真踩过）。
      * `.a` -> 可执行文件：**我们自己的链接器**（`macho_exe.js`，`omni build` 默认那一路，
        `via self`）。读数：28.3M 的 `.a`（203 成员 / 3183 条索引）→ 21.2M 的产物，链 7.8s。

    门：产物真跑一趟，`'42'.zfill(5)` / `7**80` / `repr(0.1+0.2)` 三行与本机 python3
    **逐字节相同**。这一门**不进轴表**（要现编 202 份 `.o`，~100s）—— 它是"这条链还成立"
    那一类判据，手跑；`embed.js` 那三问（7s）是日常那一格。

    顺带补的两处 `ar.js`：**GNU 的 `//` 长名字**从前不认（成员名字会原样回一个 `/12`，
    读 Linux 上 `ar` 打的库就露），以及 GNU 名字尾巴那个 `/` 现在去掉 —— 于是
    "打进去的名字 = 读回来的名字"。判据是 `tests/c/ar-read.js` 的 C 段（写出去再读回来：
    名字、字节、索引、按需取用转圈）。

27. **`**` 那一格从前静静答错 —— 整数次幂现在精确**（方言新增 `(ipow A B)`）。

    量出来的（这一轮先量后改）：`3 ** 39` 我们印 `4052555153018976256`，python 印
    `4052555153018976267`；`7 ** 22` 我们印 `…988288`、python 印 `…988049`。
    **三条腿全错，而且不报话** —— 病根是 adapter 把整数那一支也发成
    `pow(double, double)` 再 `toint`：double 只有 53 位有效位，而这些数落在 int64 里
    却落不进 double。这是最坏的一类错（答案看着像个数）。

    改法是方言加一格算子（`(ipow A B)`，五处 + 三份实现，与 `py_repr` 同一个形状）：
      * `sexpr/lower.js` 收形式（两边都要 int、不收负指数字面量）、`lower/sx.js` +
        `lower/ty-of.js` + `lower/lower-expr.js` 是标准 IR 那一层；
      * 三份实现：`omni_int.c` 的 `omni_ipow`（平方-乘，每步查溢出）、prelude 的
        `$ipow`（BigInt 算，末尾查范围）、`interp/builtin.js`（这条腿上 int 就是 BigInt）；
        `backend-llvm` 那一行签名表也加了（这台机器上没 llvm-config，那条腿没量到）。
      * **溢出 64 位报话而不回绕**：`2 ** 64` 报 `2 ** 64 溢出 64 位（无上界的整数还没接）`
        —— 那正是借 `longobject.c` 那一刀的账，话里带着它（`tests/python/run.js` 认
        "还没接"这三个字，于是这种例子算 skip 不算 FAIL）。

    adapter 那一侧还改了一格**类型**：`b ** e`（两边 int、指数不是字面量）从前一律说 real，
    于是印出来是 `4.05e+18`；现在**退到箱子**（dyn），运行期问一次"指数非负吗"——
    非负走 `(ipow)` 交 int、负的走 real 交 float。这与 python 的行为一致
    （`2 ** n` 的类型真的取决于 `n` 的符号），也是这门语言"推不出类型就退到 dyn"那条路。

    判据：新例子 `ext/python/examples/pow.py`（26 行，三条腿 interp/js/c 与 python3
    逐字节相同）、新方言判据 `tests/sexpr/cases/65-ipow.sx`（四条腿 run / run-c /
    interp / interp --mir 与 `.expected` 逐字节相同，期望值是 python3 算的）；
    `tests/python` 全套 81 过 0 败（三条腿 × 28 份例子）、`check:self` 绿。

    **顺着同一条线又抓出两格**（同一天，接着上一条）：`//` 与 `%` 的整数档也走的是
    `floor(a/b)` 再取整 —— 于是
      * `4052555153018976267 // 3` 我们答 …992000，python 答 …992089；
      * `4052555153018976267 % 3` 我们答 **267**，python 答 **0**；
      * `-big % 3` 我们答 -267（连符号那条规矩都丢了）。
    整数那两档现在落成"**截向零的商 / C 的余数 + 异号时修一格**"，一步 double 都不碰
    （方言的 int `/` 是截向零、`%` 的符号跟着被除数 —— 都量过）。判符号用整数的
    `(m ^ r) < 0`，不拿两个 bool 去比（方言里 bool 上没有那一格）。
    判据：新例子 `ext/python/examples/intdiv.py`（四种符号组合 × 小数与大数、整除那一格、
    `x //= n`、按位取数字的循环、浮点那一档；三条腿与 python3 逐字节相同）。

    **这一族的规矩就一条**：`int` 上的运算一格都不许借 double 的路。往后加算子先问这句话。

    **第三格也抓了，然后把这条线封起来**：单参 `round(int)` 从前也先提到 real
    （`round(4052555153018976267)` 答 …256），现在**实参已经是 int 就原样交回**
    （python 的 `round(int)` 就是那个 int）。接着把常用的一族整数运算在
    **2^53 ~ 2^63 那一段**上整趟走了一遍 —— `abs` / `min` / `max` / `+ - *` / 六个比较 /
    `& | ^` / `>> <<` / `str` / `int(str)` / `round` / `sum` / `//` 与 `%` 拼回原数 /
    下标 / `sorted` / 字典的键 / `float()` / 奇偶判断 —— **18 行与 python3 逐字节相同**。
    落成例子 `ext/python/examples/bigint64.py`：**往后再加整数算子，先让它过这一份**。

28. **量清了 str 那一格：我们的串是 UTF-8 字节，python 的是码点 —— 六格静静答错**
    （2026-09-28，只量没改；这一条是"借 `unicodeobject.c`"那一刀的账本）。

    探针（`héllo wörld` / `中文字符串` / `🐍`）与本机 python3 比，分三档：

    **静静答错的六格**（都是"字节当码点"）：
      * `len("héllo wörld")` —— 我们 **13**（字节），python **11**（码点）；`len("🐍")` 我们 4；
      * `s[1]` —— 我们切出半个字符（印出来是 `�`）；
      * `s[1:5]` / `s[:3]` —— 同上，切在字符中间（我们 `éll`，python `éllo`）；
      * `s.upper()` / `s.lower()` —— 非 ASCII 原样不动（我们 `HéLLO WöRLD`，python `HÉLLO WÖRLD`）；
      * `s.find("ö")` / `s.index(…)` —— 回的是**字节下标**（我们 8，python 7）；
      * `.center(15,"*")` / `ljust` / `rjust` / `zfill` —— 宽度按字节算。

    **本来就对的一档**（UTF-8 的两条性质救的，不是我们做对了什么）：
      * 比较与排序 —— UTF-8 的字节序**就是**码点序（`"é" > "e"`、`sorted` 都对）；
      * 子串查找 / `in` / `startswith` / `endswith` / `count("ö")` —— UTF-8 自同步，
        整字符的针不会在字符中间命中；
      * `%s` 那一族把字节原样穿过去。

    **已经会报话的一格**：`ord("é")` 报 `ord() expected a character (one ASCII byte)`。

    这一条把那条路劈成两半，往后照这个分：
      * **UTF-8 算术**（码点个数、按码点取下标/切片）：这是"串怎么表示"的事，不是 unicode 库，
        该我们自己做（方言里加一族按码点的算子，与 `(ipow)` 同一个形状）；
      * **unicode 的表**（大小写映射、`isalpha` 那一族、规范化、排序权重）：**借**
        （`Objects/unicodeobject.c` 已经编得出、链得上、跑得对，见第 24～26 条）。

    **现在的状态是"静静答错"，比报话坏**：所以下一刀不是先借，是先让这六格**要么对、
    要么报"还没接"**。判据现成：那份探针落在 `ext/python/examples/` 之前，得先有这一刀
    —— 不然那份例子进去就是红的（而红的例子会让整条轴不可用）。

    **第一半落了（方言这一层）**：`(scplen S)` / `(scpsub S I N)` —— 按码点数长度、
    按码点切片（`omni_str.c` 的 `omni_str_cplen` / `omni_str_cpsub`、prelude 的
    `$cplen` / `$cpsub`、`interp/builtin.js` 的 `cpLen` / `cpSub`，五处 + 三份实现，
    形状与 `(ipow)` 一样）。判据 `tests/sexpr/cases/66-cpstr.sx`：字节 13 / 码点 11、
    三字节与四字节那两档、空串与整串、"一格一格取再拼回去与原串相同"——
    四条腿（run / run-c / interp / interp --mir）与 `.expected` 逐字节相同，
    **期望值是本机 python3 算的**。
    **第二半也落了（python 那一层）**：`adapter/*.js` 里那 86 处 `slen` / `ssub` / `sfind`
    **整族换成** `scplen` / `scpsub` / `scpfind`（另加一格 `(scpfind S T)`：字节找到之后
    数一遍前面有几个码点 —— UTF-8 自同步，命中点一定落在码点边界上）。
    为什么可以"整族换"而不是一处一处挑：adapter 里那些循环本来就是**照"串是一串字符"写的**
    （`for i in 0..len(s)` 里 `ssub(s, i, 1)`），换成码点那一套之后它们就都对了 ——
    前提是"位置与长度"这件事**全族同一个单位**，所以 `find` 也得回码点下标。
    路上踩到两格：新算子要用**方言的形式名**（`scplen` 而不是内部那个 `cplen`），
    以及类型表在 `lower/ty-of.js` 的 `builtinType`（不是那个按 kind 分的 switch）。
    判据：新例子 `ext/python/examples/unicode.py`（19 行：长度 / 下标 / 负下标 / 切片夹边 /
    find·index·rfind·count·in / split·join·replace / center·ljust·rjust 的宽度 /
    "一格一格取再拼回去" / 比较与排序）—— 三条腿 interp·js·c 与 python3 逐字节相同；
    `tests/python` 全套 **87 过 0 败**、`tests/sexpr` 112 过、`check:self` 绿。

    **`ord()` 那一格也接上了**：方言加 `(scpord S)`（一格字符的码点 —— UTF-8 解一个字符）。
    从前 adapter 里那一格是**反着来的**：拿 `(chr i)` 从 0 数到 127 比一遍，于是非 ASCII
    一律报"ord() 只接 ASCII"。现在 `ord("é")` = 233、`ord("中")` = 20013、`ord("🐍")` = 128013。

    **路上纠正了一处自己写错的话**：我曾在注里写"`(chr i)` 只管 0..255，`chr(20013)`
    出的是个坏字节"—— **没量就写的，是错的**。方言的 `(chr I)` 本来就是"码点变一格字符"
    （三条腿都量过：`chr(20013)` 出 `中`、`chr(128013)` 出 `🐍`），所以那一格不必动；
    我照错结论加的 `(scpchr I)` 当场撤了（它还带着一个真 bug：C 那份把栈上的缓冲区
    当字符串回出去了 —— 症状是 C 腿印出三个 `�`。**判据抓住了它**，三条腿那一趟当场红）。

    **最后那一格：从"静静答错"改成"当场报还没接"**（第一百五十一片）。
    `.upper()` / `.lower()` / `.casefold()` / `.title()` / `.capitalize()` / `.swapcase()` 与
    `isalpha` / `isdigit` / `isalnum` / `isspace` / `isupper` / `islower` 这一族要 unicode 的
    **表**（借 `unicodeobject.c` 的事，不是 UTF-8 算术）。在借进来之前：
    **ASCII 那一档照旧走，非 ASCII 当场报**「`.upper()` 碰上非 ASCII 的串 —— unicode 的
    大小写/分类表还没接（要借 Objects/unicodeobject.c）」。话里带"还没接"，于是
    `tests/python/run.js` 把它算作**缺口**（skip）而不是绿。
    判"有没有非 ASCII"不必自己扫字节：**字节数 != 码点数**就等价于"有多字节字符"
    （`(slen s)` 与 `(scplen s)` 两格现成的算子，一趟扫描）。
    读数：`tests/python` 全套 **90 过 0 败**（ASCII 那一档一格没动）。

    于是这一条收口了：**六格静静答错 -> 五格真答对（len / 下标 / 切片 / find / ord）
    + 一族当场报还没接（大小写与分类）**。

29. **那一族要的不是整份运行时 —— 只借 `Objects/unicodectype.c`（179KB、自足）就够**
    （2026-09-28，量过；判据 `npm run py:ucase`，1.7s）。
    第 28 条末尾那笔账写的是"要借 `unicodeobject.c`"，把成本估高了一个量级。实际量出来：
    `_PyUnicode_To{Upper,Lower,Title,Folded}Full` / `_PyUnicode_IsCased` /
    `_PyUnicode_IsCaseIgnorable` 是**纯函数** —— 码点进、码点出，查的是
    `Objects/unicodetype_db.h` 那张表，**一格运行时状态都不碰**。那份 `.o` 179KB，
    链完只欠 libc 的 `printf` / `strlen`：**不用 Py_Initialize、不用那 21M 的产物**。
    探针 `ext/python/rt/ucase-probe.c` 过**我们自己的 C 前端**，**借来的那份表也过我们自己的
    C 前端**（`Objects/unicodectype.c` 一个字不改，`--format elf` 编出 178KB 的 `.o`），
    **链的也是我们自己的链接器**（`c link … --stdlib`）—— 这一格**一个外部编译器都不用**，
    也**不必先 `py:sweep` 把 201 份预热出来**，要的只是参考树里那两份文件
    （`unicodectype.c` 288 行 + `unicodetype_db.h` 292KB）与一份 python3 当 oracle。
    UTF-8 的解与编那一半**是我们自己的**（那是"串怎么表示"的算术，不是 unicode 表）。
    路上顺手补了探针缺的 `#include "pycore_unicodectype.h"` —— 少它那几个
    `_PyUnicode_To*Full` 走的是**隐式声明**（按 `int` 传 `Py_UCS4`，arm64 上恰好同寄存器
    所以答案对，那是运气不是道理）。
    判据 `ext/python/rt/ucase.js`：语料 28 个词（ASCII / `äöü` / `Straße` / `İstanbul` /
    `ǅungla` / `ﬁn` / `ΣΣΣ` / `ΌΣΟΣ` / `ΑΣ.` / 西里尔 / `ǰ` / `ΐ` / CJK / `🐍a` / 空串）
    × 4 个映射（upper / lower / casefold / title），与**本机 python3 逐字节相同**
    —— 含一对多（`Straße` -> `STRASSE`、`İ` -> `i̇`、`ﬁ`.casefold -> `fi`）与 `ǅ` 三档。
    **还有一门更狠的（门一之二）：整张表 1112064 个码点 × 4 个映射全过一遍**，读数是
    **0 格真差异**。它不比摘要 —— 两侧的 Unicode 版本本来就不一样（量到：参考树是
    CPython **3.16.0a0 / Unicode 18**，本机 python3 是 **3.14.7 / Unicode 16**），
    所以口径是"按 256 格一块比摘要找出对不上的块（6 个），在块里逐码点比，
    **每条差异都必须是'python3 那侧回原样、我们这侧给出映射'**"（= 新版加的那种，97 格）。
    反方向才是真 bug。28 个词那一门恰好落在两版共有的行为上，看不见这 97 格 ——
    这就是"整张表"那一门的价值。
    **两条要照抄的上下文规矩**（不在表里，在 `Objects/unicodeobject.c`）：
    a. **尾位 sigma**：`handle_capital_sigma` —— 前面（跳过 case-ignorable）有一格 cased、
       后面（同样跳过）没有 cased，就出 `ς`，否则 `σ`。不抄这一条的读数是 3 个词差。
    b. **`casefold()` 不走 a**：一律 `σ`（`ΣΣΣ`.casefold() = `σσσ`、`ΑΣ.` = `ασ.`）。
       我一开始把 casefold 也算进了"小写档"，读数就是那 3 个词差 —— lower / title 两档
       从一开始就对，**差异全落在 casefold 那一列**，这才定位到。
    下一刀是**语言层怎么调它**：出串那一格要么做薄皮 + `(lib)` / `(cabi)` / `(ccall)`
    （`cabi` 的类型词没有串，得走 `ptr + i64 + 调用方给缓冲区`那种协议），
    要么像 `py_repr` 那样直接做成一格 Builtin（`src/runtime/*.c` 是"额外 .o 进产物"
    唯一铺好的通道）。这一刀落下去，第 28 条那一族就能从"报还没接"变成"真答对"。

    **JS / 解释器两条腿能不能改借宿主的表？量过了：只够一半。**
    同样那 28 个词，拿 JS 的 `toUpperCase` / `toLowerCase` 与 python3 比 ——
    **upper 与 lower 两档 28/28 全对**（含 `Straße` -> `STRASSE`、`İ`、`ǅ`、
    尾位 sigma `ΑΣ` -> `ας` —— ECMAScript 的 `toLowerCase` 自己就带 final-sigma 规则）。
    差的是另外两档，**12 个词差**：
    - `casefold`：JS **没有**这一格（`toLowerCase` 不是 casefold）—— `Straße`.casefold()
      要出 `strasse`、`ﬁ` 要拆成 `fi`、`Σ` 一律 `σ`，宿主一格都不给。
    - `title`：JS 没有**逐字符的 titlecase 映射** —— `ǅ` 那三档要出 `ǅ`（JS 给 `Ǆ`）、
      合字要拆（`ﬁn`.title() = `Fin`，JS 给 `FIn`）。
    所以口径是：**三条腿要么都走借来的那张表，要么这一族就继续报"还没接"** ——
    不拿宿主的半张表去凑 upper/lower（那会让三条腿在 casefold/title 上分叉，
    正是 `py_repr` 那一格立的规矩要避免的）。JS 腿的正路还是 #9 主线那一条：
    同一份借来的 C 过我们的 C 前端 -> MIR -> JS；这份 175KB 的表是那条路**最小的样本**
    （只欠 `printf` / `strlen`，没有原子、没有 TLS、没有 Py_Initialize）。

30. **JS 腿的第一个真样本跑通了：借来的那张表 -> 我们的 C 前端 -> MIR -> JS**
    （2026-09-28，`py:ucase` 的门二）。同一份语料、同样四个映射，**与 python3 逐字节相同**
    （`ΣΣΣ` -> `σσς|σσσ|Σσς`、`Straße` -> `STRASSE|straße|strasse|Straße`、
    `ﬁn` -> `FIN|ﬁn|fin|Fin`）。这不只是"这一族能不能做对"，更是 #9 里 **JS 腿那一大块的
    第一个真读数** —— 它证明"同一份借来的 C 出两条腿"这条路是通的。
    一份翻译单元（那条路上**没有链接器**）：`ext/python/rt/ucase-js-probe.c` 三行，
    把 `Objects/unicodectype.c` `#include` 进来（参考树只读，include 就是读），
    逻辑一个字不重复。
    **路上补了命令行表一格**：`-D` / `-isystem` 这一族只挂在 `omni c` 组上（那是有意的：
    它们是 C 的事实，不该进与语言无关的顶层），而 JS 出口从前只在顶层
    （`emit js` / `run --backend js`，只认 `-I`）—— 读别人的源码当语料时不够用。
    于是在 `c` 组里加了两条：`omni c js` 与 `omni c run-js`（key 复用原来那两个实现）。
    **量出来 `mir/emit_js.js` 的两格真问题（都修了）**：
    a. data 段**一段一条语句**。C 前端把每个初始化项发成一段（一个 `int` 四字节一段），
       那张表照原样发是 **52089 条 `memData(...)`**；首尾相接的并起来之后是 **6 条**。
    b. 缩进**没有封顶**。表里那个几千格的 switch 发出来是 **2350 层嵌套**的标号块，
       一层两个空格照加，行首就有 4700 个空格 —— 一份 292KB 的 C 发成 **34MB 的 JS**，
       绝大多数字节是空白。封顶 40 层之后是 **1.35MB**。
    **那格缺口也修了（2026-09-28 当天）**：从前是"嵌套深度本身没变，V8 **解析**时按深度
    递归、默认栈过不去（`RangeError: Maximum call stack size exceeded`，**还没跑起来就报**），
    判据里挂 `node --stack-size=4000`"。现在 `mir/emit_js.js` 加了一格阈值
    （`FLAT_AT = 200` 层）：**超过就改走平铺发法** `for (;;) switch ($pc)`（`funcFlat`）——
    目标 pc 照的还是同一套层数规矩（`BR ^n`：LOOP 回 `s+1`、BLOCK/IF 去 `endOf[s]+1`，
    与 `mir/interp.js` 装载期算的那张表一致）；`BLOCK`/`LOOP`/`END` 在平铺之后不发代码，
    "顺序落下去"靠 JS 的 case 贯穿（于是"LOOP 落到底退出循环"那条 wasm 语义白拿），
    走完函数体要 `return`（少这一格就是死循环）。读数：那张表的 JS 从 1.35MB 降到
    **681KB**，`py:ucase` 的门二**不再要 `--stack-size`**。
    判据两头都有：`OMNI_JS_FLAT_AT=0` 让**所有**函数走平铺那条，`tests/c` **339 过 0 败**；
    新增一组 4.6b（六份控制流最重的 gen 用例常驻跑平铺那条，因为人写的代码碰不到
    200 层这个阈值 —— 不挂这一组，那条路平时一格判据都跑不到）。
    **这个形状的来路查清了**（2026-09-28）：C 前端降 `switch` 是"**一个 case 一层 block**"
    （`frontend-c/tccgen.js` 的 `switchStmt`：先开一层 `break` 的 block，再按标签数开 k 层，
    一个 `case` 标签关掉一层 —— 贯穿因此白拿），所以**层数 = case 数 + 1，与密疏无关**。
    `unicodetype_db.h` 里那个 switch 有 **2348 个 case**，而码点跨度 `0x30..0x109F5` 远超
    "密"的判据（`span <= 1024 && span <= covered*8`），于是走**疏**那条路：2348 条 `BRIF`
    比较链，**一条 `BRTABLE` 都没有**。2349 + 1 = 那 2350 层。
    三条路里只有一条走得通：
    - **二分查找树不解决深度**：它只省比较次数（2348 次 -> 约 12 次，native 腿也受益）。
      深度是"每个 case 体要能被单独跳到、而且彼此按源码顺序贯穿"决定的，换分派方式不动它。
      真要变浅得放弃"一个 case = 一层"，改成分组的两级分派 + 一个"是分派进来还是贯穿进来"
      的标志位（2348 格按 √n 分组约 97 层、三级约 40 层）—— 现有 MIR 表达得下，
      但要与 `goto` 状态机、`openSegs` 的段界、Duff's device 的蹦床三套机器合流，风险在
      `tests/c` 那批与 tcc 逐字节对账的用例上。
    - **`BRTABLE` 改成"跳块号"不走**：MIR 里 `BR`/`BRIF`/`BRTABLE` 的目标**一律是层数**
      （wasm 语义，`mir/ir.js` 明写"与 wasm 逐条相同，因为仓库已经有 WAT 前端，
      控制流那部分双向无损"）。加块号等于在 MIR 里同时养两套跳转模型，
      牵动 verify / interp / emit_js / backend-llvm / x64 / arm64 / opt/cfg / print / bytes
      与 `tests/mir/units/brtable.mjs` 整份。
    - **`emit_js` 按深度阈值混合发法**（这是要走的那条）：浅函数照旧发嵌套，超阈值的
      改发 `switch (pc)` 循环。两个前提**已经成立**：`mir/opt/cfg.js` 的 `buildCfg` 已经把
      结构化标记摊成基本块、而且认 `BRTABLE`；`emit_js` 已经把所有 `v{i}`/`s{k}` 提到
      函数顶上声明，摊平之后作用域不出问题。代价是要改 `emit_js` 文件头与
      `docs/adr/0013-execution-engine.md` 里"不需要 relooper / 不需要 pc 循环"那句措辞。
    **别的腿都不受这个形状影响**（同一份 2349 层的 MIR 实测）：解释器 2.8s、
    `c obj`（arm64）1.9s 出 46KB、`emit llvm` 14ms 出平铺标签的 `.ll`。
    但**clang 的括号嵌套硬限是 2048**（`fatal error: bracket nesting level exceeded`）——
    比我们这 2350 还低一档，将来真加一条 MIR -> C 腿会直接被拒。
    **顺手修了同一格的另一处**：`mir/print.js` 的缩进也没封顶 —— 800 个 case 时 `printMir`
    就要 **23.7s**（同一份 MIR 降级 0.13s、验证 4ms），真表上 `omni c mir` 直接撞超时；
    封顶 40 层之后 **1.9s**。现有快照最深 10 层，一个字节没动。
    **两门都挂进了轴表**：`tests/python/ucase.js`（薄封装）+ `tests/all.js` 的
    `{ s: 'python/ucase.js' }` + `tests/lib/incr.js` 的 `AXIS_EXTRA`（`ext/python` 动了就重跑）。
    改动过的核心（`mir/emit_js.js`）的判据：`tests/c` **339 过 0 败**（含第 4.6 组那条
    JS 腿）、`tests/mir` 两门绿、`check:self` 绿。

31. **方言层已经调得动那张表**（2026-09-28，`py:ucase` 的门三）。
    `(lib <那份 .o>)` + `(cabi _PyUnicode_ToUpperFull i32 (i32 ptr))` +
    `(pnew (ptr int) 2)` + `(ccall …)` —— 5 个码点的 `upper` 与本机 python3 相同
    （`A`、`ß` -> `SS`、`ΐ` -> 三格、`Σ`、`中`）。这一门证的是"语言层怎么用那张表"
    那一刀**不缺基础设施**，缺的是一个决定。量到的五格边界：
    a. 出参缓冲走 `(pnew (ptr T) N)`（堆上、零初始化、fat 指针，C 那侧收 `.a` 那一格）。
       方言里**没有** `(addr 局部量)` / 栈上数组 / `alloca` —— 那要求局部量可寻址，是单独一刀。
    b. 方言的 `int` 是 **8 字节、没有 u32**：一格 `int` 装两个 `Py_UCS4`，自己按小端拆
       （`& 0xFFFFFFFF` / `u>> 32`）。想省掉这一步就写一层薄 C shim，签名用 `int64_t *`。
    c. **裸 `.o` 自带链接器不收，`.a` 收**：`c link`（Mach-O 那一路）对 `--dylib` 的参数
       按后缀分派，`.a` 进 `archives`（按需取用 / `alacarte`），别的当真库或 `.tbd` 读。
       所以门三的路子是：借来的表过我们的 C 前端出 **ELF** 的 `.o`（`--format elf` ——
       自带链接器吃的是 ELF，tcc 的老路：内部表示 ELF、输出才是 Mach-O）、我们自己的
       `writeArchive` 打成 `.a`（`syms` 由 `.symtab` 说 —— 没有符号索引，按需取用就
       取不出成员，症状是"符号 '…' 没有定义"）、我们自己的链接器链。
       **一个外部工具都没用**（外部 cc 那一路也能走，`libLinkArgs` 把 `.o`/`.a` 原样
       当位置实参推上去，那时挂 `OMNI_CC=clang`）。
    d. `(lib "相对路径")` **一个字节都不解析**，按**进程 cwd** 交给链接器 —— 写绝对路径。
    e. **`(ccall …)` 在解释器腿是硬拒**（"interp: C ABI call … is not supported"）；
       backend-js 腿**能用**（`raw` 的落 `$cffi.<符号>`，走我们自己发的 N-API 扩展，
       库得是可 `dlopen` 的）。
    于是 python 那一族（`.upper()` 一家）要"三条腿都对"，摆着三条路：
    1. **ccall 路** —— C 腿与 JS 腿现在就能走，**interp 腿走不了**：那一族在解释器腿上
       只能继续报"还没接"。三条腿分叉，正是 `py_repr` 那一格立的规矩要避免的。
    2. **Builtin 路**（`py_repr` 那一套，三条腿各一份实现） —— 卡在"表从哪来"：
       C 腿要那张表**链进产物**，而"额外 .o 进产物"唯一铺好的通道是 `src/runtime/*.c`
       的硬编码目录扫描（`runtime/c_runtime.js` 的 `runtimeSources()`），而**那 21 份
       `.o` 是无条件全链上的**（两条腿都是：外部 cc 那路 `runtimeObjects()` 把它们当位置
       实参推给 clang，自带链接器那路 `runtimeObjectsSelf()` 推给 `c link`；没有 `.a`、
       没有按需取用、没有 `-dead_strip`）。量过（2026-09-28）：
       - 一份只 `(print (str "hi"))` 的产物现在是 **404KB**（clang 路）/ **786KB**（自带路），
         里头躺着整台三维光栅器（`omni_r3.o` 121KB）、整个正则引擎、整个采样 profiler ——
         `nm` 对账：每格 `.o` 导出的符号一个没少。
       - 往链接行上加一份 95KB 表的**裸 `.o`**：+99184 字节（**所有**产物一起胖，
         包括一个字符都没碰过 unicode 的程序）。同一份表**打成 `.a`** 再给：**+0 字节**
         （没人引用就不取），真有人引用时成员照样进来。
       - 把现有那 21 份 `.o` 打成一份 `.a` 再链 hello world：**404KB -> 246KB，跑对**。
       所以这条路要先修一格 omni 核心的账：**运行时应该按 `.a` 给，不是按裸 `.o` 给**。
       那一刀的风险在"只被弱约定引用的符号"（`omni_prof` 的 atexit 报告、`omni_r3` 里
       dlopen GL 那条、`omni_all_init_` / `omni_run_entry` 这类由生成的 `main` 显式调的
       入口）—— 按需取用只按"名字在索引里 + 现在还未定义"取，所以要一份**强制保留清单**
       （tcc 那边对应 `-u` / `--whole-archive`，我们现在没有）。
    3. **把那张表当数据搬一份进仓库**（`unicodetype_db.h` 292KB 源、编出来 175KB）——
       表是**数据**，不是算法：搬它不违反"库函数不自己写"（我们不重写 `To*Full` 的逻辑，
       只是不再每次去参考树里现编）。三条腿共用同一份数据，逻辑各写一遍、逐字节相同。
       这与第 3 刀"数据表挪进自述 + 产物腿走插件"是同一个方向。
    **倾向 3** —— 它是唯一能同时满足"三条腿都对"与"产物不依赖参考树"的。
    **那一件先量的事已经量了**（2026-09-28，拿本机 python3 遍历 0..0x10FFFF 全部 1114112 个
    码点，逐格算 upper/lower/title/casefold 与 9 个分类谓词，再去重）：
    - **去重之后只有 294 份记录** —— 整个 Unicode 的"大小写 + 分类"行为就这 294 种。
      这是这条路最关键的读数：表不必按码点存。
    - 两级索引（CPython 同一套形状）的合计：块 64 -> **95KB**、块 128 -> 96KB、块 256 -> 108KB。
      大头是二级块表（块 64：444 块 × 64 × 2 字节 = 56KB）与一级索引（17408 × 2 = 34KB），
      记录本身才 5～16KB。
    - 对比：现在借的那份 `.o` 是 **175KB**，还拖着"要有参考树"这个前提。
    所以路 3 的成本是"一份约 95KB 的数据 + 三条腿各一份小逻辑（查两级索引 + 尾位 sigma
    那条上下文规矩）"，比借那份 `.o` **小一半还去掉了参考树依赖**。
    数据的来路有两条，都不算"自己写库函数"：从参考树的 `unicodetype_db.h` 转一遍，
    或拿 python3 现遍历一趟生成（后者的 oracle 就是判据自己，更直）。

## 二、进度

### 已落地

- **`python.grammar`** —— 照 `Grammar/python.gram`（PEG）+ `Grammar/Tokens` +
  `Parser/lexer/` 复刻。`cpython/Lib` 下 2063 份 .py **读下来 2054 份（99.6%）**。
  一路的账、每一处偏离 PEG 的理由、还欠的 9 份都写在那份语法的文件头与末尾。
- **`src/core/glr/lex.js` 加两个字符类** `ualpha` / `ualnum` —— 标识符许 Unicode
  （PEP 3131），口径照 CPython 的词法（"码点 >= 128 就算"，不查 XID 表）。
  这是通用的一格，别的语言（js / go / nim）也用得上。
- **`adapter/`（CST → 标准 IR）+ 在 `langs.js` 登记** —— `omni run x.py` 通了。
  这一门**一个类型标注都不必写**：形参从标注或调用点推、返回类型从函数体的 `return` 推、
  模块级变量从初值推，整个扫三轮，三轮之后还推不出来的当场报（口径在
  `adapter/index.js` 文件头）。python 与 C 分道的每一处都按 python 的口径落：
  `/` 永远出浮点、`//` 向下取整、`%` 的符号跟着除数、`str + 非串`当场报、
  负下标与切片两头夹到 `[0, len]`、`print(a, b)` 一行空格连、`str(True)` 是 `True`、
  `str(4.0)` 是 `4.0`、`str([1, 4])` 是 `[1, 4]`、`math.floor` 交 int。
- **方言加一格 `(srepr E)`** —— 往返无损的 real 文本。三条腿的实现
  （`omni_repr_real` / `$repr_real` / `reprReal`）本来就在，缺的只是方言这个口；
  python 的 `str(float)` / `repr(float)` 走 `%.6g` 的话每一处浮点输出都差一截。
- **`tests/python/run.js`** —— 外部尺子：同一份 .py，我们跑一遍、本机 `python3` 跑一遍，
  **stdout 逐字节相同**才算过。**三条腿都量**（`omni run` 走解释器、`--mode js` 发 JS、
  `omni build` 发 C 再编）—— 浮点转串这些格子在三条腿上各有一份实现，只量一条等于只量了
  三分之一。现在 6 份例子 × 3 条腿 = **18 绿 0 红**（尺子 Python 3.14.7）。
- **单态化** —— 一个 python 函数按**实参类型的元组**生成几格实例
  （`add(2,3)` 与 `add(1.5,2.5)` 与 `add("a","b")` 落成三格 `add__int_int` /
  `add__float_float` / `add__str_str`；只有一格实例时不加后缀）。这是 python 的鸭子类型
  撞上方言静态类型的出路，也是往后 `class` 与容器泛型的地基。判据是 `examples/generic.py`。
- **`(srepr E)` 换成 python 自己那条排版规则** —— 从前它借的是 Omni 的 `repr(x)`
  （`%.{15,16,17}g` 的门槛跟着有效位数走），于是 `1e15` 印成 `1e+15` 而 CPython 印
  `1000000000000000.0`。现在三条腿各有一份 `py_repr`（`omni_pyrepr_real` /
  `$pyrepr_real` / `pyReprReal`）：数字取最短往返，**定点当且仅当 `-4 < decpt <= 16`**
  —— 与 `Python/pystrtod.c` 的 `format_float_short` 同一条。判据是
  `examples/floatrepr.py`（10 的幂从 1e-11 扫到 1e19，三条腿都逐字节相同）。
- **借 CPython 的 C 那一半开工了**（`ext/python/build.js` + `rt/`）。第一批借的是
  `Python/dtoa.c`（David Gay 的正确舍入转换，2841 行）与 `Python/pystrtod.c`
  （CPython 的 repr 排版规则，1286 行）—— 两份**一个字都不改**。我们只加三格：
  * `rt/shim/Python.h` —— 垫一层地板。那两份 `.c` 真正用到的 Python API 是**量出来的**
    （`grep -o '\b_\?Py[A-Za-z_]*\b'`）：`PyMem_Malloc` / `PyMem_Free`、
    `PyInterpreterState`（只为了 `->dtoa`）、`PyStatus`、`PyErr_*`、几个字符宏。
    凡是 CPython 自己有的都走它（`Py_DTSF_*` 用它的公开头、`_PY_SHORT_FLOAT_REPR` 用它的
    `pycore_pymath.h`）。
  * `rt/gen-pyconf.js` —— 探本机。名单是**算出来的**：`pyconfig.h.in` 能定义 727 个宏，
    这几份源码真读到 6 个（两格 double 字节序、`WORDS_BIGENDIAN`、`X87_DOUBLE_ROUNDING`、
    两格 gcc 内联汇编）。探法照 CPython 的 `configure.ac`（注明行号），
    **算出来的名字里有一个不认得怎么探的就当场报**。
  * `rt/gen-pyshim.js` —— 把 `struct Bigint` / `struct _dtoa_state` 从 CPython 自己那份头里
    **原样切出来**（手抄会与那棵树分叉，症状是运行期越界）。
  判据：`tests/python/rt.js` —— `repr(float)` 与本机 `python3` 在 **2035 个数**上逐字节相同
  （35 格手挑的边界 + 2000 格定死的伪随机位模式扫描）。
  顺带这是 `src/core/build/`（那台 JS 写的 ninja）的第二个生产调用者（第一个是 R 的运行时）。

* **推不出类型就退到 dyn**（`ext/python/adapter/dyn.js`）。这一刀改的是一个**错结论** ——
  原先这一门写着「方言是静态类型，所以推不出来的地方必须当场报，要一格标注」。不对：
  * 方言那一侧早就有真动态那一族（`(dyn E)` / `(dtag E)` / `(as* E)`，钉在
    `tests/sexpr/cases/48-dyn.sx`，四条腿已通），C 侧是 `omni_dyn` 那个带标签的 24 字节胖值；
  * **JS 整门语言跑的就是这条道**（ADR-0011 决策 1：「JS 的每个值都是 `dynamic`，
    不给 JS 做类型推断」），而 js→C 是自举主干 —— 动态性比 python 强的东西早就编到 C 了；
  * 口径按 ADR-0008：**异质 ⇒ 统一降为 dynamic**，一条规则，不做联合类型。
  缺的只是"标准 IR 那一层没写下这一族" —— 所以 `src/core/lower/sx.js` 的 `SX_ARITY` 补了
  `dyn` / `dtag` / `as*` 八格、`ty-of.js` 加了 `DYN` 与它们的类型、`ty.js` 的 `zeroOf` 加了
  dyn 那一格零值。C 那条腿上 `(arr dyn)` 另外要两处：`hir/types.js` 的
  `sizeOf(dynamic) = 24`（量出来的）与 `arrIsBlob` 收 dynamic（值语义的聚合，与 vec 同桶）。
  这一门于是退得下去的有这几处：**异质的表**（`[1, "two", 3.5, True]` → `(arr dyn)`）、
  **异质的字典**（`{"name": "omni", "port": 8080}` → `(dict string dyn)`）、
  **换类型的变量**（`x = 1` 之后 `x = "s"`）、**交不同东西的函数**（一支 return 数一支 return 串）、
  **`None`**（标签是 `"null"` 的那一格 —— 于是"可能没有值"这一族不必写 `Optional[int]`）、
  **箱子上的算术与比较**（`+ - * / // % **`、五格位运算与那六个比较，按 `(dtag …)`
  两边各问一次；`**` 的"指数是不是负数"在**运行期**问一次 —— 静态那一侧靠的是
  "指数是非负整数字面量"，箱子上没有那个信息）。
  判据：`ext/python/examples/` 的 `dynlist.py` / `dynvar.py` / `dyndict.py` / `none.py`
  三条腿与 python3 逐字节相同；`tests/sexpr/cases/55-dyn-arr.sx` 钉住 `(arr dyn)` 本身。
  **推得出来仍然优先**：单态化、标注、三轮推断一格没动 —— dyn 只在真的合不成一格时才用
  （箱子上的加减乘除要按标签分派，比静态那条路贵）。
  顺带钉出并修掉的两处真错：
  * `(dnull)` 之前**方言这一面写不出来** —— `DynNull` 那个 OIR 节点四条腿本来就都认
    （backend-c 的 `omni_dyn_null()`、backend-js 与 interp 的 `null`、MIR 的常量），
    缺的只是源码里的写法。补一格 `(dnull)`，`None` 与 dyn 的零值就都有着落了。
  * **函数体里赋一个名字就是造一格局部**（python 的规矩）—— 原先绑定那一趟用的是
    `lookup`（会一路看到模块级那张表），于是函数里的 `v` 撞上模块级同名的 `v` 时
    局部那一格根本不生成，`set` 打到模块级去了。改成 `lookupHere`，
    并让绑定那一趟也认 `global x`（不然 `control.py` 的 `global TICKS` 反过来坏掉）。
  明说的不足：表与记录**装不进**箱子
  （`DYN_BOXABLE` 只有 int / real / bool / string / 函数 / `(dict string dyn)`）；
  箱子里装着函数或字典时印出来的是标签本身，不是 python 的 `<function f at 0x…>`；
  `None < None` 这几个在 python 里是 TypeError，这儿答 False；
  算术碰上不该碰的标签（`"a" - 1`）是**运行期错误**而不是异常 —— 报出来比算个假数字好。

* **`class`**（`declareClasses` / `inferFields` + `expr.js` 的 `attr` / `newRecord` / `methodOf`）。
  落成方言的 `(class …)`（**引用语义** —— 两个名字指同一格）+ 方法降成
  `<类名>_<方法名>` 的普通函数，`self` 是第一格实参（mojo 那一门同一个落点）。
  字段从**类级标注**与 `__init__` 顶层那几句 `self.x = …` 认；方法按接收者类型挑实例，
  走的是单态化那张表（与自由函数同一条路）。
  判据：`ext/python/examples/classes.py` 三条腿与 python3 逐字节相同。
  明说的不足：**类不按实参单态化**（一格 `(class …)` 只有一份字段表）——
  `Point(3, 4)` 与 `Point(1.5, 2.5)` 混着造时字段该退到 dyn，而方言的字段还不收 dyn，
  所以 adapter 在自己这一侧报清楚并让人加一格标注（`x: float`）。
  继承、类方法 / 静态方法、`__init__` 之外造字段、`if` 里才出现的字段都还没接。

* **f-string 的替换字段**（`ext/python/adapter/fstring.js` + `drive.js` 递进来的 `parseExpr`）。
  整份 f-string 在词法那一层仍旧是**一个记号** —— 这套 GLR 的词法器是一张 DFA，
  没有起始条件也没有栈（`src/core/glr/lex.js:27-29`、`:56-61`；`(indent …)` 是它唯一
  一格有栈的东西，而且是显式声明的）。所以**不走 PEP 701 那条**（发
  FSTRING_START / MIDDLE / END 三族记号），走的是 jnc 那一门的先例：
  「整块当一格记号、要用时用**同一张 LR 表**再解析一遍」（`src/core/lang/jnc.js:87-119`
  的注把理由写全了）。`drive.js` 于是多递一格 `parseExpr(裹好的源码)`；
  怎么裹、怎么从树里挖出那一棵是各门语言自己的事（python 裹成 `(…)` 一句表达式语句）。
  接了的：`{expr}`、`{expr!r}` / `{expr!s}`、`{expr:.Nf}`、`{{` 与 `}}`，
  以及"字段里有引号"（`f"{d['k']}"` —— 切字段时整段跳过引号串）。
  判据：`ext/python/examples/fstring.py` 三条腿与 python3 逐字节相同。
  **单态化那一趟也要看见它们**：`f"{twice(n)}"` 里那次调用躺在 STRING 记号里，
  `allNodes` 走不到 —— 所以推断之前先把那几段解析出来挂在 `C.fstrTrees` 上
  （量到的原话：`twice(int)` 没有对得上的那一格）。
  明说的不足：别的格式说明（`:>10`、`:,`、`:x` —— `Python/formatter_unicode.c`
  那一整套微语言）、`{x=}` 自文档、`!a`，以及**里外同一种引号**（`f"{d["k"]}"`，
  PEP 701 放开的那一格 —— 那是词法层的事，语料里 8 份卡在这儿）。

* **走一遍容器的那几个内建与串方法**（`ext/python/adapter/builtins.js`）。方言里没有
  "聚合"这一族算子，可它有 `while` / `aget` / `apush` / `sfind` / `ssub` —— 所以这几格
  全是**现场发一趟循环**（与 `expr.js` 里 `listRepr`"表转串"同一条办法），
  **三条腿一行没改就通**。
  接了的：`sum` / `min(xs)` / `max(xs)` / `min(a,b,c)` / `sorted` / `any` / `all` /
  `list(range(…))`，串上的 `.join` / `.split(sep)` / `.strip` / `.lstrip` / `.rstrip` /
  `.replace` / `.startswith` / `.endswith`，字典上的 `.get(k)` / `.get(k, 默认值)`。
  为什么不往方言里加算子：这几个是**python 自己的规矩**（`sum([])` 是 `0`、
  `"a,,b".split(",")` 的空段算一格、`.strip()` 去哪几个空白字符），不是汇聚层该知道的 ——
  加进去就要替十几门语言各自的差别背账。
  两处顺带钉出来的：
  * **`d.get(k)` 交的是一格箱子**（dyn），不是值的类型 —— 键不在时 python 交 `None`，
    而**方言的 `dget` 在键不在时交零值**（量到过：`d.get("z")` 印出个 `0` 来）。
    所以要先问一句 `dhas`，有就装箱、没有就 `(dnull)`。`.get(k, 默认值)` 则把
    "值的类型"与"默认值的类型"合成一格（一样就是它，不一样两边都装箱）。
  * **`xs = []` 之后 `xs.append(v)`** —— python 里最常见的那一格写法。空表自己答不出
    元素类型，所以绑定那一趟从 `xs.append(v)` 认（`arr<v 的类型>`），
    赋值那一句再按认出来的类型造一格空的。语句是按次序扫的，够用。
  判据：`ext/python/examples/builtins.py` 三条腿与 python3 逐字节相同（29 行）。
  明说的不足：`.split()` 不带分隔符那一档（按连续空白切、首尾空段不算 —— 与带分隔符
  是两条规矩）、`round(x, n)`、`int("42")` / `float("2.5")`（串转数要走借来的
  `pystrtod`）、`tuple()`（没有元组这一档）。

* **`for i, v in enumerate(xs)` 与 `for a, b in zip(a, b)`**。python 里这两个交的是
  **一串元组**，而这一层没有元组这一档 —— 可这两种写法落下去都只是**一格下标循环**
  （enumerate 的第一格就是下标，zip 是两张表同一个下标），所以不必先有元组。
  `zip` 走到**短的那一张**为止；`enumerate(xs, start)` 的第一格是 `下标 + start`；
  两个都收表与串。判据在 `builtins.py` 尾部。
  别的拆包（`for k, v in d.items()`、三格以上的目标）还没接 ——
  前者卡在"走一遍字典的键"那一格上（见下）。

* **老式的 `%` 格式化**（`ext/python/adapter/percent.js` + `expr.js` 的 `percentOf`）。
  python 这一族照的是 C 的 printf，而**方言里那几格串算子本来就是 C 的那几个转换** ——
  `sfix` = `%.*f`、`ssci` = `%.*e`、`sgen` = `%.*g`、`sbase` = `%x` / `%o`（小写，
  要大写裹一层 `supper`）。所以 adapter 不自己算数字的文本，只管切格式串、挑算子、补宽度。
  接了的：`%s %r %d %i %f %e %g %x %X %o %%`，标志 `-` / `0` / `+`，宽度与精度
  （写成数字的那一档）。`0` 补零**补在符号后头**（`"%05d" % -12` 是 `-0012`，
  不是 `00-12` —— 这一条是拿 python3 比出来的）。
  判据：`ext/python/examples/percent.py` 三条腿与 python3 逐字节相同（26 行）。
  明说的不足：**格式串要是编译期的字面量**（转换字母决定发哪一格算子；运行期的格式串要
  一台运行期的格式化机器 —— 那是 CPython 的 `unicodeobject.c` 里那一大段）；
  `*`（宽度从实参来）、`#`、`%(名字)s` 那一族没接。

* **表上那几格"找"与"改"，以及 `in` 落在表上**。方言里表那一族只有
  `anew` / `aget` / `aset` / `apush` / `alen` / `apop` —— 所以
  `v in xs`、`.index(v)`、`.count(v)`、`.reverse()`、`.extend(ys)`、`.clear()`、
  `.insert(i, v)`、`.remove(v)`、`.pop(i)` 全是**现场发一趟循环**。
  改原表的那几格在 python 里交 `None`，所以只当语句用（`LIST_MUT` 那张表）；
  当表达式用会当场说清。比法与 `==` 同一条（`cmpEq` —— 元素是箱子时按标签分派），
  所以异质的表也走得通。串上顺带补了 `.ljust` / `.rjust` / `.zfill`。
  判据：`ext/python/examples/listmut.py` 三条腿与 python3 逐字节相同。
  几条口径是拿 python3 比出来的：`insert` 的下标**夹到 `[0, len]`**（超了就是追加）、
  `index` 找不到是 ValueError（这儿 `(fail …)`）、`zfill` 够宽了原样不截。

* **`(slower S)`** —— 方言加一格，与 `(supper S)` 完全对称（只动 ASCII 的 A-Z，
  两个函数只差那一对常量）。落在七处：`sexpr/lower.js`、`lower/sx.js` 的 `SX_ARITY` 与
  构造器、`lower/ty-of.js`、`backend-c` / `backend-js`（含 prelude 的 `$str_lower`）/
  `interp`（`asciiLower`）/ `backend-llvm` 的符号表、`runtime/omni_str.c` 的
  `omni_str_lower`。判据：`tests/sexpr/cases/57-slower.sx` 三条腿逐字节相同。
  python 的 `.lower()` 接到它上面。

  **顺带量出来一处会答错的地方（不是"还没接"）**：`.upper()` / `.lower()` 在
  **非 ASCII 上与 python 不一样** —— `"äöü".upper()` 我们交 `äöü`（python 交 `ÄÖÜ`）、
  `"Straße".upper()` 我们交 `STRAßE`（python 交 `STRASSE`，长度还变了）。
  `.upper()` 这一处是**早就在的**，这一刀只是把它照出来。
  根因是方言那两格定成 ASCII-only —— 而那正是它们四条腿能是同一个函数的前提
  （`tolower` 看 locale、JS 的 `toLowerCase()` 是 Unicode 的）。
  要对得上得借 `Objects/unicodeobject.c` 的大小写映射表（§一 的借用名单里本来就有它）。
  在那之前**只有 ASCII 那一档是对的**，`listmut.py` 里只钉 ASCII。

* **`(dkeys D)` —— 走一遍字典的键**。方言加一格：交**所有的键**，一格 `(arr K)`，
  次序是**插入序**（与 python 3.7+ 的 dict 同一条）。`for k in d` / `d.keys()` /
  `d.values()` / `for k, v in d.items()` / `print(d)` / `str(d)` 都落在它上头。
  判据：`tests/sexpr/cases/58-dkeys.sx` 四条腿（run / run-c / interp / interp --mir）
  逐字节相同；`ext/python/examples/dictwalk.py` 三条腿与 python3 逐字节相同。

  查过之后的落法比原先估的小得多：**js 与解释两条腿一行转换都不用** —— 那边 `arr` 与
  `list` 同是一个裸 JS 数组（`$anew` 回 `[]`、`arrNew` 回 `[]`），所以 `keys_arr`
  与 `keys` 逐字同一句。只有 **C 那条腿要抄一遍**：`omni_arr_*` 是
  `{len, cap, items}`、list 是 `{items, len, cap}`，**字段顺序不同**，指针一转类型
  `len` 就读到 `items` 上去了。于是 `backend-c` 的 `containerDefine` 逐字典生成一个
  `static <字典>_keysarr`，里头调运行时那个 `_keys`（死格的跳过逻辑留在它那儿，
  共享宏一个字不动）再抄进 `omni_arr_*`。原先记的两条出路（给方言加 `list` 那一档 /
  在 OIR 里插一格转换节点）都不用走。

  `.values()` 没给方言加算子：它是键表的一个推论（`builtins.js` 的 `valuesList`
  现场发一趟循环，逐个 `dget`）。`.items()` 只在 `for k, v in d.items():` 里接
  （走 `pairIter` 那条路，与 `enumerate` / `zip` 同一格下标循环）——
  当值用要有元组，这一层没有元组那一档。

  **明说的不足**（两条，都拿 python3 比出来的）：
  `d.keys()` 在 python 里是个**视图**（`dict_keys([...])`，改字典之后跟着变、
  `print` 出来带那层壳），我们交的是抄出来的一张表 —— `list(d.keys())` 那种写法
  两边逐字相同，裸 `print(d.keys())` 不同。另一条是同一个作用域里**同一个名字**
  当两张键类型不同的字典的循环变量：那个名字会合成 dyn（ADR-0008），而方言的
  `dget` 的键要静态对上，于是报「dget 的键要是 string，这里是 dynamic」——
  各起一个名字就行（`dictwalk.py` 里就是这么写的）。

* **`(ddel D K)` —— 字典删一格**。答的是**原先在不在**（不是语句，与 `dset` 那一格
  不同）：`del d[k]` 与 `d.pop(k)` 在 python 里键不在都是 KeyError，那一格布尔是真要
  拿去判的。来路与 `dkeys` 同一条 —— 运行时那个 `_remove` 连墓碑（`idx[h] = -1`）
  与小表那条没有索引的路都写好了，`remove` 这格内建三条腿也都认，缺的只是方言的开口。

  python 那一侧接上四种写法：`del d[k]`（键不在报 `KeyError: 'z'`，与 python 末行同形）、
  `del xs[i]`（表那一格没有新算子，往前挪一格再 `apop`，与 `.pop(i)` 同一条）、
  `d.pop(k)` / `d.pop(k, 默认值)`（`dictPopOf` —— `dget` 必须排在 `ddel` 前面，
  删过就读不到了）、`d.clear()`（走一遍抄出来的键表逐个 `ddel`；python 里它交 None，
  所以只当语句用）。一句删几格（`del d["a"], xs[0]`）也走得通。

  判据：`tests/sexpr/cases/59-ddel.sx` 四条腿逐字节相同（那一份专门钉"删过再加，
  键的次序还是插入序" —— 删只灭 `live[i]`、不挪 `keys[]`）；
  `ext/python/examples/dictdel.py` 三条腿与 python3 逐字节相同。

  **明说的不足**：`del 名字` 不接 —— 那要有"这一格还绑着没有"这一层，而方言里一格
  变量就是一格槽位，没有那一档（猜一个，比如置零值，会让后面读到的东西看着像对的）。
  `del xs[1:3]` 也没接。  两条错的路（KeyError / 越界）只保证**会当场炸**，
  那句话与 python 的 traceback 不逐字相同。

* **推导式**（`[e for x in xs if p]` / `{k: v for …}` / `(e for x in xs)`）。
  **方言一格新算子都不加** —— `anew` / `apush` / `dnew` / `dset` 加一趟 `while` 就够，
  与 `builtins.js` 里 sum / sorted 那几格同一条办法。目标位收一格名字，或者两格名字配
  `enumerate` / `zip` / `d.items()`（与 `for` 语句那一侧同一份名单）。
  可迭代收表 / 串 / `range(…)` / 字典（字典先转键表）；`if` 从句可以挨着写几个；
  `for` 可以嵌套，后一格的可迭代能用前一格的目标。
  判据：`ext/python/examples/comprehensions.py` 三条腿与 python3 逐字节相同。

  **循环变量不漏到外头**这一条是自己挑出来做对的：python 3 里推导式有自己的作用域，
  办法是把那个名字在推导式里临时改成一格新名（ctx 上新增的 `alias`）**并单开一层作用域**，
  发完指回去。不改名的后果是真会答错 —— 外头的 `x` 与推导式里的 `x` 会被合成一格 dyn
  （ADR-0008），于是 `x = 99` 之后印出来的是表里最后那一格。
  单开那一层也是量出来的：**模块级那张表 `C.globals` 按 python 的原名存**
  （`lookup` 的兜底那一句用的是 `n` 而不是 `C.ref(n)`），只改 `ref` 的话
  `SEED = [x * 10 for x in BASE]` 写在模块级时 `x` 查不到，整条推导式答 null，
  `SEED` 那格全局就没声明（症状是 `.sx` 那侧报"未声明的变量 'SEED'"）。

  **明说的不足**：生成器表达式当成"立刻算完的一张表"（python 是懒的）——
  差别只在无穷的生成器（我们会挂住）与副作用的次序上露头，`sum(x * x for x in xs)`
  这类用法两边一样。集合推导式没接（方言里 `set` 那一族没开口）、
  `[*i for i in xs]`（PEP 798）没接、`async for` 没接。

* **表上的拼接与重复，加上剩下那几个内建**。`xs + ys` / `xs * n`（都是**新造一张表**，
  两边不动）、`reversed(xs)`、`repr(x)`、`hex` / `oct` / `bin`、`round(x, n)`、
  `sum(xs, start)`、带步长的切片（`s[::2]` / `s[::-1]`）。方言一格新算子都没加 ——
  `hex` 那一族落在早就有的 `(sbase E 进制)` 上，别的都是现场发一趟循环。
  判据：`ext/python/examples/listops.py` 三条腿与 python3 逐字节相同。

  **这一刀里唯一一处"从前会答错"的是 `round()`**：python 的 round 是**半数取偶**
  （`round(2.5)` 是 2、`round(-2.5)` 是 -2），而方言的 `(rmath "round")` 是 C 的
  "远离零"（交 3）。量出来之后用 floor / fmod 拼出半数取偶（`builtins.js` 的
  `bankRound`）——**没给方言加 `nearbyint`**：那要五条腿各写一遍，而 JS 的
  `Math.round` 也不是半数取偶。

  另外顺手补了一处**既有的**坑：`sliceOf` 从前把被切的那一格重复发了几遍
  （长度一次、取元素一次），被切的东西是表字面量时里头那格 `let` 就发了两次 ——
  `[1, 2, 3, 4][::2]` 报「'list81' 在这一层已经声明过了」。现在先把它钉成一格临时量。

  **明说的不足**：两参 `round` 我们走二进制的乘除、CPython 走十进制
  （`_Py_dg_dtoa`）—— `round(2.675, 2)` python 交 2.67、我们交 2.68。
  根子不在 `bankRound`（`2.675 * 100.0` 在双精度里真是 267.5，两边的一参 round 都把
  它舍成 268），而在"该不该先转十进制" —— 那是接 `libomnipy` 那一刀的事。
  负步长的切片只接两头都省掉的写法（`s[::-1]`）：带显式两头的那一族还要另一套夹法，
  猜一个会静默给出错的一段。`xs + []` 里那个空表字面量照旧要先有一格标注。

* **命名实参与多目标赋值**。`f(b=2, a=1)` / `Point(y=4, x=3)` / `sorted(xs, reverse=True)` /
  `print(…, sep=, end=)`，加上 `a, b = x, y`（含 `a, b = b, a` 那个交换）。
  判据：`ext/python/examples/kwargs.py` 三条腿与 python3 逐字节相同。

  **命名实参只是换个次序** —— 这一层没有"默认值"那一档（`def` 的形参带默认值当场报），
  所以按形参名字排回位置上就完事（`kwOrder`）。要紧的是**三处都要排**：
  建 IR 那一趟、问类型那一趟（`tyOfCall`）、以及**收单态化实例那一趟**
  （`collectInsts`）—— 漏掉最后一处的话按次序取的类型会错位，挑出来的实例是错的那一格。
  内建不走这条通路（各有各的规矩）：`print(sep=, end=)` 与 `sorted(reverse=)` 在
  各自那一处收；`sorted(reverse=…)` 只收 True / False 字面量（升序降序是两条循环，
  与 `range` 的步长同一条理由）。

  多目标赋值那一半发射侧本来就对（右边全算完再赋 —— `a, b = b, a` 靠的就是这一条），
  缺的是**绑定那一趟**：`bindTarget` 的元组那一支把整个右边的类型按到每一格名字上，
  而 `tyOfCst((tuple …))` 答 null，于是一格都没绑，落到 `.sx` 那侧报"未声明的变量 'a'"。
  现在两边同长时逐格对着绑。

  **明说的不足**：`*args` / `**kw`（形参与实参两侧都是）没接；形参带默认值没接；
  `sorted(key=…)` 没接（要有函数当值那一档）；元组本身还没有那一档，所以
  `t = (1, 2)` 与 `return a, b` 照旧报"还没接" —— 多目标赋值是把它**绕开**了
  （两边逐格对着走，中间不真造一格元组）。

* **改原容器的那几格、`for…else`、`isinstance`**。`xs.sort()` / `.sort(reverse=True)`
  （**就地**排，`sorted()` 才抄一份）、`d.update(other)`、`d.setdefault(k, v)`、
  `for…else` / `while…else`、`isinstance(x, T)`。方言一格新算子都没加。
  判据：`ext/python/examples/moreops.py` 三条腿与 python3 逐字节相同。

  `for…else` 那一支是"**没 break 就跑**"，不是"循环完就跑"。落法是一格布尔旗子：
  进循环前置 true，体里**属于这一层**的每个 `break` 前面补一句置 false，出来之后
  `if 旗子:`。"属于这一层"要紧 —— 递归进 `if` / `block` 那几层，**不进**嵌套的
  `for` / `while`（那里头的 break 跳的是里层那一圈）。

  `isinstance` 静态的那一档在**编译期**就答得出（这一层的类型是确定的），一格箱子那一档
  问 `(dtag …)`。`isinstance(True, int)` 照 python 交 True（bool 是 int 的子类）。

  **明说的不足**：`.sort(key=…)` 没接（同 `sorted`）；`isinstance` 的第二格收元组
  （`isinstance(x, (int, str))`）没接；`type(x)` 没接。

* **元组**。`(1, "a")` / `t[0]` / `a, b = t` / `return a, b` / 逐格比的 `==` /
  `len(t)` / `for a, b in ts` / `zip` / `enumerate` / `d.items()` 当值用 / 推导式里。
  判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  落法：**按形状生成一格记录** —— `(1, "a")` 的类型是 `Tup2_int_string`，字段 `_0` / `_1`。
  为什么不给标准 IR 加一档"元组"：元组就是定长、逐格各有自己类型的东西，那正是记录，
  而记录这一档从声明、字段读写到四条腿早就通了。引用语义（`cnew`）—— python 的元组
  不可改，"是不是同一份存储"观察不到。字段名是 `_0` / `_1`，而方言的字段是**名字**
  不是下标，所以 `t[0]` 的下标**要写成字面量**（python 代码里几乎总是；负的编译期折过去）。

  **量出来的三条**：
  1. `(1, 2) == (1, 2)` 原先会静默答 **False** —— 落成"是不是同一个句柄"了。现在逐格比
     （`cmpOne` 里那一支）。形状不同的两格元组 `==` 恒 False，与 python 同。
  2. `inferFields` 会把元组那几格记录的字段**抹成空**（它从标注与 `__init__` 认字段，
     元组两样都没有）—— 先报"类 Tup2_int_string 至少要有一个字段"，接着字段读回来的
     类型也跟着错（`a, b = t` 报"b 先装 string 后装 int"）。那一趟要跳过元组。
  3. 元组的声明是**建 IR 的时候**才登记的，所以 `pyToIR` 里"先摆声明再建体"的次序得
     反过来（先建体、再摆声明）—— 不然声明表看不见它们。

  **明说的不足**：空元组 `()` 不收（记录至少要一格字段）；切元组没接；
  下标不是字面量的 `t[i]` 不收。（`zip` 当时只收两格 —— 后面那一刀放开成 N 格了，见下。）
  （`<` / `>` 与 `sorted()` 排元组当时也没接 —— 后面那一刀补上了，见下。）

* **f-string 的格式说明**（`:>10.3f` / `:05d` / `:^6` / `:x` / `:+.2f` / `:*^8`）。
  原先只接 `:.Nf`。现在收下那套微语言的一块：填充 + 对齐（`< > ^`）、符号
  （`+` / `-` / 空格）、`0`、宽度、`.精度`、类型（`d f s x X o b`）。
  方言一格新算子都没加 —— `sfix` / `sbase` / `supper` / `srep` / `ssub` 拼出来的。
  判据：`ext/python/examples/fstring.py` 三条腿与 python3 逐字节相同。

  几条口径是拿 python3 比出来的：**没写对齐时数右对齐、别的左对齐**；
  `:.N` 落在串上是**截到 N 个字符**（不是小数位）；`:^N` 的**余数放右边**；
  `:0N` 的零补在符号后面（`-1.5:08.2f` 是 `-0001.50`）；空的格式说明（`{7:}`）
  与没写是一回事。

  **明说没收的**（都当场报，不猜）：`#`（`0x` 前缀）、`,`（千分位）、`=`（符号后填充）、
  `e` / `g` / `%` / `n`、宽度或精度写成 `{}`（从实参来）。

* **串上剩下那一批方法，加上 `.copy()`**。`.title()` / `.capitalize()` / `.swapcase()`、
  `.strip(chars)` / `.lstrip(chars)` / `.rstrip(chars)`、`.isalpha()` / `.isdigit()` /
  `.isalnum()` / `.isspace()` / `.isupper()` / `.islower()`、`.rfind()` / `.index()` /
  `.rindex()`、`.removeprefix()` / `.removesuffix()`、`.center()`，以及表与字典的 `.copy()`。
  方言一格新算子都没加。判据：`ext/python/examples/strmethods.py` 三条腿与 python3 逐字节相同。

  **拿 python3 比出来的三条口径**（照着文档写会写错的）：
  - `.title()` 的边界是"前一格不是**字母**"，数字也算边界 —— `"a1b".title()` 是 `A1B`；
  - `.isupper()` 是"**有至少一格大写、而且没有小写**"，不是"每一格都大写" ——
    `"A1".isupper()` 是 True、`"1".isupper()` 是 False。`.isalpha()` 那一族反过来：
    每一格都要在类里、而且串非空；
  - **`str.center()` 与 f-string 的 `:^` 摆法不一样**：`'ab'.center(7,'*')` 是 `***ab**`
    （多的在左），`f"{'ab':*^7}"` 是 `**ab***`（多的在右）。

  **明说的不足**：只动 ASCII（同 `.upper()` / `.lower()`，要借 `unicodeobject.c`）；
  `.split()` 不带分隔符、`.split(sep, maxsplit)`、`.partition()`、`.format()`、
  `.encode()`、`.count(sub, start, end)` 那一族带范围的都还没接；
  `.center(w)` 的 w 要写成字面量。

* **`pow` / `list(…)` / `dict(…)` / `.split(sep, maxsplit)`**。
  判据：`ext/python/examples/builtins.py` 三条腿与 python3 逐字节相同。

  **顺带修了一处会答错的**：`list(xs)` 从前直接交**原表**（"先当同一格"），
  所以 `ys = list(xs); ys.append(v)` 把 xs 也改了 —— python 的 `list()` 是浅拷贝。
  现在抄一份。`list(串)` 拆成一格一个字符、`list(字典)` 交键表。

  `dict(一串两格的元组)` 走元组那一档（键重了后一格盖前一格）。`dict(a=1)` 那种
  命名实参没接。`type(x)` **明说不接** —— 这一层没有"类型当值"那一档，要判类型用
  `isinstance`；照 `type(x)` 交个串出来会让 `type(x) is int` 静默答错。

* **元组的字典序，以及"怎么比"递下去**。`(1, 2) < (1, 3)` / `<=` / `>` / `>=`、
  `min(ps)` / `max(ps)` / `min(a, b)`、`sorted(ps)` / `sorted(ps, reverse=True)` /
  `ps.sort()`。判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  字典序落成**一棵短路的纯表达式**，不发分支：
  `a < b` ⇒ `a0 < b0 || (a0 == b0 && (a1 < b1 || (a1 == b1 && …)))`；最后一格用算子
  本身（`<=` 只在那儿才允许"到底都相等也算真"），前面各格一律用严格的那一版。
  `||` / `&&` 本来就短路，所以"第一处不同的那一格说了算"是白来的。

  **顺带修了一处会答错的**：`min([(2, "b"), (1, "a")])` 从前答 `(2, 'b')` ——
  `pickList` / `sortedOf` / `sortStmts` 直接发的是方言的 `<`，落在记录上就是**比句柄**，
  三条腿各自答一个样（JS 那条腿两个对象比 `<` 恒假，于是留下第一格）。现在这三处都收一格
  `less(a, b)`，由 `expr.js` 递 `cmpOne('<', …)` 进来 —— 谁会比、怎么比只有一处说得清。
  排序之前先过 `needOrd`：有比法的就三类标量加**同形状的元组**，别的当场报，不静默答错。

  明说的不足：**形状不同**的两格元组比大小不收（python 是逐格比到第一处不同、都一样就
  短的那格小，而对上的两格类型不同那一处还会 TypeError）；链式比较里中间那一格要是元组
  字面量不收（那一格只算一遍，所以要求它是纯的）；`sorted(key=…)` 还是没接（要"函数当值"）。

* **`.partition()` / `.rpartition()` / `.count()` / `.replace(a, b, n)` / `.split()`**。
  判据：`ext/python/examples/strmethods.py` 三条腿与 python3 逐字节相同。

  `.partition()` 交**三格串的元组** —— 上一刀把元组落成记录之后这一格几乎是白来的
  （`tupleRec([STR, STR, STR])` 加 `sfind` / `rfindOf` / `ssub`）。量出来的两条：
  找不到分隔符时**两边站的位置不对称**（`partition` 交 `(s, '', '')`，`rpartition` 交
  `('', '', s)`）；而且**不能用三元** —— 这一层的三元两支都会算，`ssub(s, 0, -1)` 当场炸，
  所以三格先各落一格临时量、再发一句 `if`。

  `.count()` 数**不重叠**的那几段（`"aaa".count("aa")` 是 1），空的那一段数的是"位置数"
  （`"abc".count("")` 是 4）；`start` / `end` 按 python 的规矩折（负的加长度、再夹进
  `[0, len]`）。`.replace(a, b, n)` / `.split(sep, maxsplit)` 同一条办法：一格计数器，
  到数了就把 `hit` 摆成 -1，剩下的整段算最后一格。

  `.split()` 不带分隔符（或者 `.split(None)` / `.split(None, n)`）是**另一趟循环**，
  不是"找分隔符"：按连续空白切、首尾的空段不算（`" ".split()` 是空表，
  而 `" ".split(" ")` 是两格空串）。所以它要在带分隔符那一支**之前**拦。

  明说的不足：`.format()` 与 `.encode()` 还没接；`maxsplit` / `count` 要写成整数字面量
  （两种走法是两条循环，得在编译期定）。

* **比两张表 / 两格字典**（`==` / `!=` 逐格比，`<` / `<=` / `>` / `>=` 按字典序）。
  判据：`ext/python/examples/listops.py` 三条腿与 python3 逐字节相同。

  **又一处静默答错的**：`[1, 2] == [1, 2]` 从前答 **False** —— 方言里没有"比容器"这一族
  算子，落下去就是**比句柄**，与元组那一处同一个病。这三处（`listEqOf` / `listCmpOf` /
  `dictEqOf`）现场发一趟走一遍，比法还是那一格 `cmpOne` 递下去 —— 所以元素是箱子、
  元组、又一张表都自动对（量过 `[[1], [2]] == [[1], [2]]` 与 `[(1, 2)] == [(1, 2)]`）。

  表的字典序与元组那一棵树不同：长度要到运行时才知道，所以是循环加一格 `done` 顶着
  （方言里没有"从循环里带值出来"那一档，`break` 只管跳）。前缀一路相等时**长度说了算**，
  而且用的就是原来那个算子 —— `[1] < [1, 0]` 真、`[1, 2] <= [1, 2]` 真。

  字典只比相等：python 里字典没有大小之分（`d < e` 是 TypeError），所以那四格当场报。
  元素 / 值的类型对不上时 `==` 编译期就定成 False（`[1] == ["1"]`），而比大小当场报
  （python 会在第一处不同那里 TypeError）。

* **bool 当数用、`divmod()`、串上的挑与排**。
  判据：`ext/python/examples/numbers.py` 三条腿与 python3 逐字节相同。

  python 的 **bool 就是 int 的一种**（`True + True` 是 2、`2 ** True` 是 2），而方言里
  那是两档类型 —— 所以二元算术那一处见了 bool 就现折一格 `b ? 1 : 0`，`int(True)` 同。
  **位运算不折**：python 的 `True & True` 交的是 `True` 而不是 `1`，印出来不一样，
  那一格还是当场报（明说的不足）。顺带补了 `**` 的指数认 `True` / `False`
  为整数字面量 —— 不补的话 `2 ** True` 会交 `2.0`（折完就是"指数不是 num 词法"了）。

  `divmod(a, b)` 交一格两格的元组，取整与取模直接用 `//` / `%` 那两份
  （`floorDiv` / `pyMod`）—— python 的符号规矩不用再说一遍。

  `sorted("bca")` / `min("abc")` / `max("abc")` 走 `charsOf` 拆成字符表再交给原来那趟。

* **`str.format()`**。判据：`ext/python/examples/fstring.py` 三条腿与 python3 逐字节相同。

  模板**要是串字面量** —— 替换字段得在编译期拆开（每一格的说明各是一套代码，与 f-string
  同一条口径）。格式说明那一段**直接借 f-string 那一份 `fmtSpec`**：两处本来就是同一套
  规矩，各写一遍必然对不上。认的写法：`{}`（顺着数）、`{0}`（指名第几格）、`{!r}` / `{!s}`、
  `{:说明}`、`{{` / `}}`。

  明说的不足：按名字取（`{x}` / `.format(x=1)`）没接；说明里的宽度写成 `{}`（从实参来）
  没接 —— 与 f-string 欠的是同一批。`.encode()` 还是没接（要有 bytes 那一档）。

* **`int(串)` / `int(串, 进制)`**。判据：`ext/python/examples/builtins.py` 三条腿与
  python3 逐字节相同（错的那条另量：报的话与 CPython **逐字一样** ——
  `invalid literal for int() with base 10: '12x'`）。

  这一格**原先记成"要借 CPython 的 C"，那是记错了**：借 C 是为了浮点的"最短往返"
  （`dtoa`），而整数逐位乘加本来就是精确的。所以现场发一趟循环就够（`intOfStr`）。
  照 python 的规矩：两头空白许、`+` / `-` 许、数位之间的 `_` 许、`0x` / `0o` / `0b`
  前缀在进制对得上时吃掉（大小写都认）、一位有效数字都没有就 ValueError。

  `base` 要写成**编译期的字面量**（前缀与数位表都跟着它定），收 2..36；python 还许
  `base=0`（"看前缀猜"）那一档没接。超出 int64 的不管（要 bignum，见下面第 5 条）。

* **切元组**。判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  切元组是**编译期的事** —— 交出来的形状（几格、逐格什么类型）由三个边界定，所以三个
  边界都要写成字面量，算出下标清单后按新形状造一格记录。算哪几格照 python 自己那套
  `slice.indices` **抄**：负的加长度再夹住，而且**步长为负时两头的夹法与正的不一样**
  （`t[::-1]` 是从 `n-1` 到 `-1`，不是从 `n` 到 `0`）。
  同一份清单也给类型推断那一趟用（`tyOfCst` 的 `index` 那一支），不然 `u = t[1:]`
  在模块级推不出类型。

  明说的不足：切出来是**空的**那几刀不收（`t[5:]` 在 python 里是 `()`，而记录至少要有
  一格字段 —— 与空元组字面量同一个卡点）。

* **形参的默认值，以及"实参是局部变量也要收得到实例"**。
  判据：`ext/python/examples/kwargs.py` 三条腿与 python3 逐字节相同。

  默认值与命名实参**走同一处**（`kwOrder`）：命名的排回位置上，缺的那几格把 `def` 上那棵
  **默认值的原文树**补上去。这么办与单态化正好合得上 —— `f(1)` 与 `f(1, 5)` 补完都是两格
  实参，推出来是同一格实例。代价是默认值**只收字面量**（后来放宽到"字面量与模块级常量"，
  见下头那一刀）：python 的默认值是 `def` 那一刻
  算一遍、以后共享同一格，`def f(xs=[])` 两次调用改的是同一张表，而展开就成了两张 ——
  字面量看不出区别，可变的差得是根本的，所以那一档当场报，不悄悄换语义。

  **顺带修了一处更大的**：`collectInsts` 原先是**平铺全树**扫调用点的，所以调用点上的
  局部变量在 `tyOfCst` 那儿答 null —— 于是 `x = 3` 之后 `dbl(x)` 报"`dbl(int)` 没有对得上
  的那一格（生成的是 (x)）"，`b = Box(3)` 之后 `b.area(2)` 报"对不上那一格的形参"。
  也就是说**实参只要是局部变量就不算**，而真的 python 代码里几乎全是局部变量。
  现在多走一趟：按每格函数实例 `push` 一层、绑上形参、`scanBinds` 走一遍体（与 `inferRet`
  同一条办法），再在那一层里扫里头的调用点。体里的名字一次全绑上（不按语句次序）——
  与推断跑三轮那条口径一致：宁可多收一格实例，也别漏。

  还量到一处读错：`(p (n a) (default e))` 里没写标注时**第二格就是 `(default …)` 本身**，
  照 `kids(p)[1]` 读会把默认值当标注（`annotTok`）。

  明说的不足：`*args` / `**kw` / 只能按名字给的那一档（`def f(*, c=3)`）还没接；
  两个类有同名方法而默认值不同时，那一处不补（`calleeSig` 回 `null`，退回从前的行为）。

* **元组当序列用**（`x in t` / `for v in t` / `list(t)` / 推导式里走元组）。
  判据：`ext/python/examples/tuples.py` 三条腿与 python3 逐字节相同。

  两种落法，都是**展开**（元组的格数与逐格类型都是编译期定的）：
  `x in t` 编译期铺成一串 `==` 或起来 —— 类型对不上的那一格在 python 里恒 False，
  所以**跳过它**，别发一格比不了的 `==`；`for` / `list()` / 推导式则先逐格摆进一张新表
  （`tupleToList`），后面那一段与走一遍表逐字同一条。异质的那格元组摆出来是
  `(arr dyn)`，逐格装箱。

  要改的地方有四处，少一处就露：`containsOf`（`in`）、`forStmt`（语句）、
  `compIter`（推导式建 IR）、以及**两份"元素是什么类型"**——`elemOf`（语句那侧的绑定）
  与 `compElem`（推导式那侧）。  漏掉后两处的症状是"用到了没赋过值的名字 'v'"
  与"推导式里 `for v in …` 的可迭代推不出元素类型"。

* **`ord()` / `.expandtabs()` / `.splitlines()` / `d.popitem()`**。
  判据：`builtins.py`（ord）、`strmethods.py`（那两格串方法）、`dictdel.py`（popitem）
  三条腿与 python3 逐字节相同。

  `ord()` 方言里没有"串 → 码位"那一格，所以**反着来**：拿 `(chr i)` 从 0 数到 127，
  对上了就是它（128 步是上限）。只有 ASCII 那一档对得上 —— 非 ASCII 的字符在这一层是
  **几个字节**，对不上就当场报，不悄悄答个字节值出去。

  `.expandtabs(n)` 的制表位是**按列**算的（补到下一个 n 的整数倍，正好在倍数上也补满
  一格），而列数**每换一行归零** —— 照着"一个 tab 换 n 个空格"写就错。
  `.splitlines()` 与 `.split("\n")` **不是一回事**：末尾那个换行不留空段
  （`"a\n".splitlines()` 是一格、`.split("\n")` 是两格），`\r\n` 算一个分隔。
  只认 `\n` 与 `\r`（python 还认 `\v` / `\f` / U+2028 那一批 —— 明说的不足）。

  `d.popitem()` 拿掉**最后进来的**那一对（python 3.7 起是 LIFO，不是随便挑一格），
  交一格两格的元组。`dkeys` 交的是插入序，所以"最后一格键"就是它 —— 那一条口径
  （删只灭 live、新的追在尾巴上）本来就与 python 的 dict 对齐，这一格是白来的。

* **`d = {}` 不带标注也认得出来，以及 else 支里的赋值**。
  判据：`ext/python/examples/dictwalk.py` 三条腿与 python3 逐字节相同。

  `xs = []` 之后 `xs.append(v)` 早就能认（空表的元素类型从 append 的那个值来），可
  **`d = {}` 之后 `d[k] = v` 一直要标注** —— 同一条办法补上就行（`bindEmptyDict`）：
  赋值那一句先不绑，等走到写它的那一句，按 `map<键的类型, 值的类型>` 绑上。
  键只认 int 与 str（方言的字典键就这两档）。

  **顺带修了一处更大的**：`scanBinds` 那一趟**不剥 `(else (body …))` 这一层** ——
  `flatten` 只剥 `line` / `body`，而 `if` / `while` / `for` 三处都是把整格 `(else …)`
  递进去的，于是 **else 支里的赋值一格都不绑**。症状就是这一刀最常见的那种写法报错：
  `seen = {}`，然后 `if ch in seen: … else: seen[ch] = 1` —— 唯一定得下类型的那一句
  正好在 else 支里。  这一处影响的是所有绑定推断，不只是空字典。

* **`sorted(key=…)` / `xs.sort(key=…)`** —— lambda **就地展开**。
  判据：`ext/python/examples/listops.py` 三条腿与 python3 逐字节相同。

  这一格原先记成"要有函数当值那一档（`asfn`）"，其实**不必等它**：`key=` 收的是一格
  **lambda 字面量**，那就在编译期把它的体展开 —— 按元素算一遍、攒成一张"键表"，
  排序时两张表**一起挪**，比的只看键（`sortByKeyStmts`）。
  形参那个名字用 `C.alias` 临时指到一格新名上（与推导式那一处同一条办法），发完指回去，
  所以 `key=lambda v: …` 写在一个已经有 `v` 的函数里也不会撞。

  为什么不是"递一格比较器进来"（`needOrd` 那一族的办法）：比较要落在 `while` 的**条件**
  上，而键那一段常常带几格临时量（`block-expr`）—— 摆进条件里每转一圈都要重算，还容易
  在条件位置上炸。先算成一张表，之后就只是两个标量比大小。

  `min(xs, key=…)` / `max(xs, key=…)` 同一条：挑键最小 / 最大的那一格，**交回去的是元素**
  （不是键）。那一处还要记住"`key=` 不算一格实参" —— `tyOfCall` 里不看这一条会把
  `min(xs, key=…)` 的类型答成那张表。

  明说的不足：`key=` 只认 lambda 字面量（`key=f` 传一个具名函数还是要 `asfn`）；
  lambda 只收一格形参、不带默认值。

* **切片赋值**（`xs[a:b] = ys`）。判据：`ext/python/examples/listmut.py` 三条腿与
  python3 逐字节相同。

  两边长度**可以不一样**，这是 python 的规矩。办法：先在一格临时表里拼出
  "前段 + ys + 后段"，再把 xs **清空、照抄回去**。为什么不是造一张新表交出去 ——
  python 改的是**那个对象**，别处拿着同一个句柄的要一起看见
  （`alias = xs; xs[0:1] = [9]` 之后 `alias` 也变；这一条在例子里单独钉了一格）。

  两头按 python 的规矩折（负的加长度、再夹到 `[0, len]`），而且 `b < a` 时当**插入**看
  （`xs[2:1] = [8]` 是"在 2 处插进去"）。右边是空表字面量时元素类型从**左边那张表**来。

  明说的不足：带步长的（`xs[::2] = …`）没接 —— python 那一档要求两边格数一样，
  是另一条规矩；右边要是一张**同型的表**（python 收任何可迭代）。

* **`print(*xs)`**。判据：`ext/python/examples/kwargs.py` 三条腿与 python3 逐字节相同。

  要印的那几段**先攒成一张串表**，再用分隔符 join。为什么不是逐段拿 `+` 接起来 ——
  展开的那张表**可能是空的**，而 python 那时不多摆一个分隔符
  （`print("a", *[], "b")` 是 `a b`，不是 `a  b`）。表的长度是运行时才知道的，
  所以"有几段"这件事只能在运行时数，攒表再 join 正好是这个意思。
  `print(*"ab")` 走 `charsOf`（一格一个字符）。

  明说的不足：`print(**d)` 没接；`f(*xs)` 落在**普通函数**上没接（那要形参个数在运行时
  才定，与单态化对不上）。

* **箱子上的 `*` 认串**（`"ab" * 3` 落在 dyn 那条道上）。
  判据：`ext/python/examples/dynvar.py` 三条腿与 python3 逐字节相同。

  这一格不是"还没接"，是**运行期一句错**：`(asnum …)` 把串往数上掰，报
  `dynamic value is string, expected real`。量到的路子：`v = 1` 之后 `v = "s"`
  （那一格名字按 ADR-0008 合成 dyn），再 `v * 2`。`+` 那一支早就有"两边都是串就拼起来"，
  `*` 漏了对称的那一支 —— 现在按标签分派：一边串一边 int 走 `srep`，别的照旧走数。

  这一处是接"实参是局部变量也收得到实例"那一刀**顺手量出来的**：从前 `g(v)` 连实例都挑
  不到（当场报），够不到运行期；能编出来之后这一格才露头。

* **N 格的 `zip`，以及 N 格目标的拆包**（`zip(a, b, c)` / `for a, b, c in ts` /
  `[e for a, b, c in …]`）。判据：`ext/python/examples/tuples.py` 三条腿与 python3
  逐字节相同。

  三处各改一点，合起来才通：
  1. `pairsList` 里那对 `first` / `second` 换成**一张 `parts` 表** —— `zip` 那一支
     `args.map(pin).map(at)`，走到最短的那一张为止（长度用 `reduce` 折出来）；
     `enumerate` / `items` 还是两格，只是也摆进 `parts`。记录按 `parts.length` 造。
  2. `forStmt` 多一条路：目标是 N 格名字、而可迭代的元素是**对得上的 N 格元组**时，
     发一格下标循环，体开头逐格取 `_k`。两格那一档仍走 `pairIter`（那儿另有
     enumerate / items / zip 三条**专路**，省一张中间表）。
  3. `compBind` / `compLoop` 同一条：多记一张"拆包表"，循环体开头摆几句赋值。

  还要顺手改 `scanOne` 的 `for`：`bindTarget` 的元组那一支会把**整格记录**按到每一格
  名字上（它不知道这是拆包），所以 N 格目标要逐格绑 `tup[k]`。

  明说的不足：**嵌套的拆包**（`for a, (b, c) in …`）不收；`zip` 的实参只收表与串。

* **函数里套函数（不读外层名字的那一档）**。
  判据：`ext/python/examples/nested.py` 三条腿与 python3 逐字节相同。

  python 的嵌套 `def` 有两种用法：一种只是"把一段逻辑关在里头"（不读外层的任何名字），
  另一种是真闭包（读外层的局部）。**前者与模块级的 `def` 没有区别** —— 提到模块级就是
  （`hoistNested`），单态化那一套照旧、那一句 `def` 本身不发东西。后者要"把捕获的那几格
  连函数一起带走"，是 `(asfn …)` 与环境那一层的事，所以**当场报** —— 不悄悄把它当前者办，
  那会读到一个不存在的名字。

  判据是一句话：**内层用到的名字里，有没有落在外层的形参或局部上**（内层自己的形参与
  局部先减掉 —— 那是遮住的，不算捕获）。量到一处要当心的：**套在里头的 `def` 的名字不算
  "外层的局部"** —— 它自己也会被提上去，所以一格嵌套函数调它的**兄弟**不是捕获
  （`a2` 调 `a1` 原先被误判成闭包）。

  明说的不足：真闭包当场报；套在里头的 `def` 与外头重名当场报（提上去会撞）；
  `nonlocal` 还没接。

* **四格最常用的写法**：`self.n += by` / `a, b = s.split(",")` / `sorted(字典)` /
  类上的 `__str__`。判据：`classes.py`、`kwargs.py`、`dictwalk.py` 三条腿与 python3
  逐字节相同。

  这四格是**照着真代码的样子探出来的**（写一批"像人写的"片段逐个与 python3 比），
  而不是照着语言手册往下推 —— 四格都在最常见的那几行里：

  - `o.f += v` 落成 `o.f = o.f + v`。**接收者要是一格名字**（`self.n` 那种）：这一手把它
    读一遍写一遍，不纯就会算两遍，而 python 只算一遍 —— 所以那一档当场报。
  - `a, b = 一张表`：长度要跑起来才知道，所以**发一句运行期的检查**（python 那儿是
    ValueError），再按下标逐格取。顺带要改绑定那一趟：`bindTarget` 的元组那一支会把
    **整张表**按到每一格名字上，症状是"'left' 先装 arr、后装 string"。
  - `sorted(字典)` 排的是**键**（与 `for k in d` 一条）。
  - 类上的 `__str__`：`str(p)` 与 `print(p)` 都走它。**没定义 `__str__` 的类当场报** ——
    python 那时印 `<__main__.X object at 0x…>`，里头有地址，逐字节比不了，不装作有。

* **又一轮"照着真代码探"，五格**：`self.xs: list[int] = []`、`dict(pairs)` 的类型、
  `min` / `max` 落在字典上、`.pop()` / `.pop(i)` 当值用，以及**一处会答错的求值次序**。
  判据：`classes.py` / `dictwalk.py` / `listmut.py` 三条腿与 python3 逐字节相同。

  **`print(xs.pop(), xs)` 原先答 `2 [1, 2]`（python 是 `2 [1]`）**。根子：python 是
  **从左到右**把实参算完的，而 `printStmt` 是把几段拼成一个大表达式 —— 段里带的
  `block-expr` 那几句会被提到整句最前头，于是**后面那一段的转串跑在前面那一段的副作用
  之前**（转 `xs` 那趟循环跑在 `apop` 之前）。现在实参**按次序各落一格临时量**，次序就
  回来了。这一类要记在账上：**凡是"把几段拼成一个表达式"的地方，段里有副作用就得先钉住**
  （f-string 与 `"a" + str(…)` 那几处后来一起钉上了 —— 见下面"拼串的那四种写法"）。

  另外四格：
  - `self.xs: list[int] = []` 那一句是 `annot` **不是 `assign`**，认字段那一趟只看
    `assign`，于是那格字段根本没认出来（报"没有字段 items（一格都没有）"）；发射那一侧
    也要收 attr 目标的带标注赋值。
  - `d = dict(pairs)`：`tyOfCall` 里没有 `dict` 这一格，那格名字**一直没绑上**，
    发到 `.sx` 那侧报"未声明的变量 'd'"。
  - `min(d)` / `max(d, key=…)` 落在字典上走**键**（与 `for k in d` / `sorted(d)` 一条）。
  - `.pop()` 早就当值用得了，`.pop(i)` 没接（先读那一格、再抽掉它）。

  还量到一格**卡在方言那一层**的：`d = {}` 之后 `d[k] = []` 加 `d[k].append(v)` ——
  adapter 这一侧现在推得出 `map<int, arr<string>>`（从 append 的那个值认），可方言的
  `(dict K V)` 的**值**只收 `int / real / bool / string / 类名`，而且那一格类型是**按原子
  读的**（`(arr string)` 是个表，根本写不出来）。所以"字典装一串表"那种分组写法要等
  方言那一刀 —— 就是下面这一条。

* **字典的值收一张表**（`(dict K (arr V))`）—— 这一刀落在**公共那一层**
  （`src/core/sexpr/lower.js`），不是 python 这一侧。原先值那一格是**按原子读的**，
  嵌套的类型形连写都写不出来；现在值是 `(arr …)` 时递归读一遍。与"值是一格类"是同一档：
  格子里躺的还是一个句柄（`(arr …)` 是引用语义），**运行时那份表的步长不用动**，
  OIR 一个新节点都不加。
  判据：`tests/sexpr/cases/60-dict-arr.sx` 四条腿（run / run-c / interp / interp --mir）
  与手写的 `.expected` 逐字节相同（`run-llvm` 记在 `CANT` 上，理由同 `44-dicts`：
  LLVM 后端不接聚合容器，主语言也一样）；`dictwalk.py` 里那段分组（`group_by_len` /
  `bag["even"].append(i)` / `d[k].sort()` / `print` 嵌套的 repr）三条腿与 python3
  逐字节相同。
  （`(dict K (dict …))` 后来也收了 —— 见下面"字典的值也是一张字典"那一条：零值就按空句柄，
  与这一档一个规矩。）

  顺手补一格**类型**：`sorted(字典)` / `list(字典)` 交的是一张键表，可 `tyOfCall` 那一侧
  从前对 map 交 null —— 发射那一侧早就走 `dkeys` 了，缺的一直是类型。于是
  `for k in sorted(d)` 报"用到了没赋过值的名字 'k'"（循环变量绑不上），而
  `print(sorted(d))` 好好的 —— 那条路上没人问过类型。这一格提示"**能跑的写法不等于
  类型齐了**：要拿类型的位置（循环目标 / 赋值的右边）才会把洞照出来"。

* **字段收一张字典，加上实参位置上的空容器**（两格连在一处量出来的）。写
  `Bag([], {})` 这种再常见不过的一句时，先撞上"空表 `[]` 的元素类型推不出来 ——
  给它一格标注"，可**实参位置上压根没处写标注**；把那一格补上之后，露出来的是方言的
  **字段白名单里没有 dict**（`self.tags: dict[str, int]` 让整个类连声明都过不去，
  后面每一处 `self.tags` 跟着全红）。这一条又是那句老账：**补上"编译不过"的洞，
  它挡着的下一格才露头**。
  - 实参位置上的 `[]` / `{}` 从**形参那一格**认（`paramWants`）—— 与 `xs = []` /
    `d[k] = []` 同一条（"空容器的类型从左边来"）。**只在实例唯一时认**：几格实例摆着
    说明这个函数按实参类型单态化过，那时猜哪一格都是错的。
  - 方言的字段收 `(dict K V)`（`src/core/sexpr/lower.js`，公共那一层）。与"字段是一张表"
    （`(arr T)`，早就收）同一档：格子里躺一个句柄、与标量同宽，布局 / 零值 / 四条腿的
    字段读写全是现成的 —— **缺的只有那张白名单**。
  判据：`tests/sexpr/cases/61-dict-field.sx` 四条腿与手写的 `.expected` 逐字节相同
  （零值是**一张真的空字典**不是空句柄；`fldset` 装外头那张进去是引用语义；值语义的
  结构体拷的是那格句柄 —— 浅拷，与 go 的 `map` 字段同一档）；`classes.py` 里那格
  `Counter([], {})` 三条腿与 python3 逐字节相同。
  **明说的不足**：形参没标注、而且**这个函数只被 `f([])` 这一种写法调过**时，那一格形参
  退到 dyn，报的是 `len()` 作用在 dyn 上没有这一格（`len` 收箱子是另一格账）。

* **字段收一格箱子（dyn）** —— 接着上一条，同一张白名单上的下一格。量到的地方就是
  `Point(3, 4)` 与 `Point(1.5, 2.5)` 混着造：**函数按实参类型单态化，可类不**
  （一格 `(class Point …)` 只有一份字段表），所以那两格字段该退到 dyn（ADR-0008）。
  从前 adapter 只能在自己那一侧当场报、让人加标注；现在方言收了，adapter 那道拦也撤了。
  **一行发射代码都没添**：`sizeOf(dynamic) = 24` / `arrIsBlob` 收 dynamic / 装箱的
  `writeTo`（`f.type.kind === 'dyn'` 那一支）全是现成的 —— 又是"机器在下一层早就有了，
  缺的只是上面那张表"。
  判据：`tests/sexpr/cases/62-dyn-field.sx` 四条腿与手写的 `.expected` 逐字节相同
  （零值的标签是 `null`；值语义的结构体拷一份就是拷那 24 个字节，拷完改源值拷出来那份
  不跟着变；`(arr S)` 里的元素走按字节那条 blob 路，dyn 在里头也一样）；
  `dynvar.py` 里那格 `Point` 三条腿与 python3 逐字节相同（`a.x = "ten"` 也在里头）。
  **明说的不足**：几处装的东西**连箱子都装不进**（表与记录装不进 dyn）那一档照旧报 ——
  但报的话换了地方：从前那一格字段被静静摘掉、下一层说"`Holder` 没有字段 `v`（一格都
  没有）"，现在 `inferFields` 就地说清"在几处造出来时装的是 int / arr —— 合不成一格"。

* **`map` / `filter`** —— 又一次"先问能不能在编译期展开"：两格都铺开成一趟循环，
  与 `key=lambda` 同一条办法（那一处的机器本来就在，这一刀是把它抽成
  `applyPer` / `applyTy` 两条，三处共用）。可调用的那一格只收**编译期定得下来的三档**：
  lambda 字面量 / 这份源码里的 `def` / 一格内建（`str` / `int` / `len` / `abs` …）。
  顺带**`key=` 也松了口**：从前只收 lambda 字面量，现在 def 与内建都收
  （`sorted(ws, key=len)` / `sorted(ws, key=shout)`）。
  单态化那一侧补了一格：`map(f, xs)` / `filter(f, xs)` / `key=f` 里那个 f **不是一处调用**，
  所以 `collectInsts` 原先一格实例都收不到（报"\`dbl(int)\` 没有对得上的那一格"）——
  现在按**元素类型**单独收一格（`takeTys` / `elemOfCst`）。
  判据：`builtins.py` 那一段（`list(map(…))` / `for v in map(…)` / `sum(map(…))` /
  `",".join(map(…))` / `filter(None, …)` / 串与字典上的 map）三条腿与 python3 逐字节相同。
  **明说的不足**（python 交的是懒迭代器，我们交一张真表）：`print(map(f, xs))` 在 python
  里印 `<map object at 0x…>`（里头有地址，逐字节比不了，所以不判）；迭代器**只能走一遍**，
  我们两次都满。多路的 `map(f, a, b)` 还没接。

* **拼串的那四种写法按次序钉住**（一处**真会答错**的求值次序，与 `print` 那一处同一条账）。
  `f"{xs.pop()} {xs}"` 原先答 `2 [1, 2]`（python 是 `2 [1]`）：段里带的 `block-expr`
  那几句会被提到整句最前头，于是**后面那一段的活儿跑在前面那一段的副作用之前**
  （转 `xs` 那趟循环跑在 `apop` 之前），而 python 是从左到右算的。
  四种拼法一起修：f-string、`str(a) + " " + str(b)`、`"%s %s" % (…)`、`"{} {}".format(…)`。
  办法是一条公共的 `pinPiece` / `concatPieces`（纯的那几段不钉），加上 `binOf` 里
  "两边都带副作用时左边先钉住"那一句。
  判据：`fstring.py` 末尾那五行（四种拼法 + 一行两次 `pop()`）三条腿与 python3 逐字节相同。
  **这一格把 SPEC 里挂了一阵的"明说的不足"销掉了** —— 那条不足本来就是这一类错的预告。

* **空容器的类型从"它被递给哪一格形参"认**（`bindFromParams`）。`memo = {}` 那一句自己
  答不出键值类型（与 `d[k] = v` 同一条口径：赋值先不绑，等走到用它的那一句）；而
  `fibm(20, memo)` 里那格形参标注了 `dict[int, int]` —— 那就是它的类型。一样的信息，
  只是从前不从那一侧看，于是报"空字典 `{}` 的键值类型推不出来"。
  **只认实例唯一、而且形参是表或字典的那一档**：几格实例说明这个函数按实参类型单态化过，
  那时猜哪一格都是错的；标量那几档不必从这儿认（右边自己答得出来），从这儿认反而遮住
  真该报的错。
  判据：`generic.py` 里那格带备忘的 `fibm` 三条腿与 python3 逐字节相同。
  **明说的不足**：`memo` 那一格形参**也不标注**时还是不行（调用点一格实例都收不到、形参
  退到箱子）。报的那句话里现在带上了提示（"形参没标注、调用点又推不出来时会退到箱子"）。
  要从函数体里那句 `memo[n] = v` 反推形参是另一刀：三轮推断里还有一处循环要解
  （形参的类型要体里那句，而那句的值类型又要这个函数的返回类型）。

* **排一串元组排错了**（又一处真会答错的，五格以上才露）。元组那一档的"怎么比"要把两边
  各钉一格临时量（逐格比要读好几遍），而**摆进 `while` 的条件里那几格 `let` 会被提到
  `while` 外头** —— 于是每转一圈读的还是头一圈那两个值，插入排序的内层循环该停的时候
  不停。四格以下碰巧对，所以先前没露：`sorted([(3,"c"),(1,"a"),(2,"b"),(5,"e"),(4,"d")])`
  原先答 `[(4,'d'),(2,'b'),(1,'a'),(3,'c'),(5,'e')]`。
  修法：**比较摆在循环体里**，内层循环靠一格"还往前挪吗"的标记（`sortedOf` 与 `sortStmts`
  两处都是）。这一条本来就记在账上（"比较不要递进 `while` 的条件里"），这一次是它真咬了人。
  判据：`tuples.py` 末尾那一段（九格的表 / 五格的表 / `.sort()` / `reverse=True` /
  第一格相同看第二格 / `min` `max`）三条腿与 python3 逐字节相同。

* **`d[k] = d.get(k, 0) + 1` 那种"数一遍"的写法**（`looseTy`）。这一句是绕回来的：右边要
  先知道 `d` 装什么（`.get` 问的是它），而 `d` 装什么正要从右边认 —— 于是报"空字典 `{}`
  的键值类型推不出来"。可 `1` 就摆在那儿：**方言的 `+` 要两边同型，答得出来的那一边就是
  答案**。`d[k] = d[k] + 1` 是同一条。只对 `+` / `-` 这么办（`/` 在 python 里 int/int 交
  real，`*` 还有"串重复"那一档，两边不必同型）。
  判据：`dictwalk.py` 里那两段（`.get` 那种与 `if k in d` 那种）三条腿与 python3 逐字节相同。

* **条件里夹着几句话的那两处**（又两处真会答错的，连着量出来的 —— 修完第一条第二条立刻露头）。
  - **`while` 的条件**：串上那几个分类（`isdigit` / `isalnum` / …）要现场走一趟循环，于是
    条件那一格是 `block-expr`；摆在 `while` 的条件位上，那几句会被提到 `while` **外头** ——
    条件就冻在头一圈那个字符上了。症状：`tokenize("x1 + 42")` 只交一格记号
    `('name', 'x1 + 42')`。改成 `while true` + 体开头"条件不成立就 break"，那几句就落在
    体里、每圈重算（`continue` 照旧对 —— 跳到 while 顶上也就跳回那几句前面；
    `while … else` 也照旧：那一格 break 打了 `synthetic` 记号，`markBreaks` 不动它）。
  - **`and` / `or` 不短路**：右边那几句被提到整句前头，于是右边照算 ——
    `while j < n and src[j].isdigit()` 在 `j == n` 那一圈当场炸（`substring out of range`）。
    落成一格临时量加一句 `if`：只有该算右边的时候才算。
  判据：新的 `scan.py`（一台小 tokenizer：数字 / 名字 / 算符三档，带 `continue`）三条腿与
  python3 逐字节相同，加上 `if` / `or` / `while … else` / `break` / `continue` 各一格。
  **一条可复用的判断：凡是"这一格 IR 夹着几句话"（`block-expr`），摆进任何"只该按条件算"
  的位置（循环条件、`and`/`or` 的右边、三元的两支）都要先问一句"那几句会被提到哪儿"。**

* **表的元素收一张字典**（`(arr (dict K V))`）—— python 里"一串记录"那种写法：
  `rows = []` 之后 `rows.append({...})`（从 CSV / 配置里读出来的东西几乎都是这个形状）。
  与"数组套数组"（`(arr (arr T))`，早就收）**同一档**：格子里躺一个句柄（字典是引用语义），
  走 `arrIsBlob` 那条按字节的路，零值是空引用（谁要哪一格谁先造）。
  这一刀落在公共那一层，**两处都是表**：`sexpr/lower.js` 的元素白名单，与
  `hir/types.js` 的 `arrIsBlob`（少了后面那一格，C 那条腿会走标量那条路、`arrSuffix`
  当场抛 —— 这一处提醒：**白名单开了口，还要问一句"下一层按什么形状认它"**）。
  判据：`tests/sexpr/cases/63-arr-dict.sx` 四条腿与手写的 `.expected` 逐字节相同
  （要点是引用语义：推进去之后改源头那张字典，表里那一格跟着变）；`collections.py` 末尾
  那一段三条腿与 python3 逐字节相同。

* **一张报表探出三格**（对齐 + 取整 + 格式化那一片）：
  - **`"%…" % x` 的类型也是串**。发射那一侧早就在算右边之前拦了（右边是一格元组，这一层
    没有元组那一档），可类型那一侧漏了：`%` 落到"两边都是数"那一条上、答 real。平时看不
    出来（拼进 `print` 就没人问它的类型），**`return` 那一处一问就露** —— 报"要返回 real，
    给的是 string"（返回类型是按 `tyOfCst` 推的，推错了就与真发出来那一格对不上）。
  - **`min` / `max` 里 int 与 real 混着来**：方言的三目两支必须同型，所以这一档**两边都
    装箱**。**不能把 int 提到 real** —— python 的 `max(3, 2.5)` 交的是 `3`，印 `3` 不是
    `3.0`（`dyn.js` 文件头那条"不要把 int 与 real 混着来的那一档提到 real"就是这个理由）。
  - **平手时留左边那一格**：python 的 `min` / `max` 交的是"第一个最小/最大的"，所以
    `max(2, 2.0)` 是 `2`、`max(2.0, 2)` 是 `2.0`。比法要**非严格**（`!(右 < 左)`）——
    这一格平时看不出来（值一样），是上面那一条把它照出来的。一格表那条路（`pickList`）
    本来就对：只在**严格**更好时才换。
  判据：`numbers.py` 与 `percent.py` 各一段，三条腿与 python3 逐字节相同
  （`round(0.5)` / `round(2.5)` 的半数取偶、`%8.2f`、`f"{255:x}"`、`0.1 + 0.2`、
  `10 ** 18` 这些同一份里一起压过）。
  **明说的不足**：`float(串)` 当场报了（从前落到方言那一层报"toreal 的参数要是 int"）——
  串转浮点要"最短往返"那一档（借来的 CPython `pystrtod`，见下一刀），自己写的解析会在
  末位上差一点，不装作有。`int(串)` 是另一回事（逐位乘加本来就精确）。

* **串上那三格：`.zfill` 的符号（会答错）、`.rsplit`、`.casefold`**。
  - **`.zfill(w)` 不是 `rjust(w, "0")`**：开头那一格符号（`+` / `-`）要留在最前头 ——
    `"-7".zfill(4)` 原先答 `00-7`，python 是 `-007`。空串那一档要当心：**先问长度再取头
    一格字符**（`ssub(s, 0, 1)` 在空串上是 "substring out of range"），所以是两层 `if`
    不是一句 `&&`（这一层的 `&&` 两边都算 —— 与"条件里夹着几句话"那一条同一族的账）。
  - **`.rsplit(sep[, maxsplit])`**：`splitOf` 的镜像（从右往左找，最后把表倒过来）。
    **不是"先 split 再挑后几段"** —— maxsplit 是从右数那么多次，段数一样但分界不同
    （`"a-b-c".rsplit("-", 1)` 是 `['a-b', 'c']`，split 是 `['a', 'b-c']`）。
    不带分隔符的 `.rsplit()` 与 `.split()` 同一格；`.rsplit(None, n)` 还没接。
  - **`.casefold()` 在 ASCII 那一档就是 `.lower()`** —— 真正的 casefold 与 lower 只在
    非 ASCII 上分家（`ß` → `ss`），而非 ASCII 的大小写本来就明说没接，所以走同一格，
    不另编一套半对的规矩。
  判据：`strmethods.py` 末尾三段三条腿与 python3 逐字节相同。
  **明说的不足**：`.isascii()` / `.isidentifier()` 还没接（前者要"这一格字节小不小于
  0x80"，而这一层拿字节值只有 `ord()` 那一条、它在非 ASCII 上是当场报的 —— 先不猜）。

* **`.insert` 的负下标**（又一处会答错的）：python 的 `insert(i, x)` 落在
  `max(0, len + i)`，而 len 是**插之前**那个长度 —— 所以 `-1` 是"插在最后一格之前"。
  从前这儿把负的一律夹成 0，`[9,3,8,1,2,7].insert(-1, 6)` 插到了最前头。
  要紧的是**长度要在 `apush` 之前取**（这一格的实现是"先追加再往后挪"）。
  判据：`listmut.py` 末尾那一段（0 / 正 / 超界 / -1 / 超界的负 / 一格表 / 空表）三条腿与
  python3 逐字节相同。
  顺手量过、本来就对的一批：`xs[::-1]` / `xs[::2]` / `xs[::-2]` / `del xs[i]` /
  `xs += […]` / `.extend` / `.clear` / `.copy` / `.remove` / `.count` / `.index` /
  `d.setdefault` / `d.update` / `d.popitem`。

* **实参位置上的 `range`，与 `isinstance(x, (A, B))`**（一轮"推导式 + 走一遍"的探针挑出来的）。
  - `range` 当值用本身**照旧不接**（python 印 `range(0, 3)`，铺成一张表就印错了），可
    `list(range(3))` / `sorted(range(3))` / `reversed(range(4))` / `sum(range(5))` 这几种
    写法只是"要一串数" —— 所以按**吃序列的那一格名单**（list / sorted / reversed / sum /
    min / max / any / all / len / tuple / enumerate / zip）在**算实参之前**铺成表。
    从前只有 `list(range(…))` 一格有专路。
  - `isinstance(x, (A, B))`：一格元组就是"哪一格都算"，逐格问一遍再 `or` 起来。
    那一格值要问好几遍，所以只收名字或字面量（带副作用的先落一格变量）。
  判据：`comprehensions.py` 末尾两段三条腿与 python3 逐字节相同。
  顺手量过、本来就对的一批：带条件的推导式 / 两层推导式 / 字典推导式 /
  `for i, (k, v)` 之外的 `enumerate(d.items())` / 三路 `zip` / 循环里 `s += …` /
  `assert` / 生成器当实参（`sum(x for x in xs if …)`）。
  **明说的不足**：`for i, (k, v) in …` 那种**嵌套拆包**还没接（`for` 的目标只收名字与
  一层元组）；集合推导式等 `set` 那一刀。

* **`for` 的目标里套一层元组**（`for i, (k, v) in enumerate(d.items())` 那一族 —— SPEC 里
  挂了一阵的"嵌套拆包"那一条）。办法与 `a, b = t` 同一条：**先把那一格钉成临时量**
  （右边可能是 `dget(…)` 那种算一遍不便宜的），再逐格取 `_k`。
  三处一起改：`pairIter`（两格目标各自许"名字或一层元组"）、`pairFor`（目标落成体开头
  那几句，走新的 `loopTargetStmts`）、`scanBinds`（`bindPairTarget` 逐格绑 —— 不绑那几个
  名字就没有函数头上的 `let`；`bindTarget` 的元组那一支会把**整格记录**按到每一格名字上）。
  顺手修掉一格**从前就错的**：同一个名字当过两趟循环的目标、两趟元素类型不一样时那一格
  合成 dyn，可赋值那一句**没装箱** —— 报"'q' 是 dynamic，赋的值是 int"。
  判据：`tuples.py` 末尾那两段（`enumerate(d.items())` / `enumerate(表里的元组)` /
  `zip` 的左边套元组 / 元素本身是"元组套元组" / 同名两趟不同型）三条腿与 python3 逐字节相同。
  **明说的不足**：再套一层的（`for a, ((b, c), d) in …`）还不收 —— 那一档还没量过，不猜。

* **字典的值也是一张字典**（`(dict K (dict …))`）—— python 里"两层配置"那种写法
  `cfg[sec][key] = v`（从 JSON / ini 读出来的东西几乎都是这个形状）。
  与"值是一张表"（60-dict-arr）同一档：格子里躺一个句柄，运行时那份表的步长不用动。
  **那条"零值要新造一张空字典"的顾虑撤了**：与 `(arr …)` 值那一档一个规矩 —— 零值是
  **空句柄**，谁要哪一格谁先造（读一格没写过的键当场报 null reference）。不另编规矩。
  adapter 这一侧多认一格：**一个标注都不写也认得出来**。`cfg = {}` 与 `cfg["db"] = {}`
  两句自己都答不出（右边都是空字典），答案在**再下一句** `cfg["db"]["port"] = 5432` 里 ——
  `bindEmptyDict` 现在把"值是 `(dict kt vt)`"**往外推一层**再问一遍。
  判据：`tests/sexpr/cases/64-dict-dict.sx` 四条腿与手写的 `.expected` 逐字节相同
  （引用语义两头都判：改源头里层字典外层跟着变、直接往外层那一格上写源头也看得见；
  三层也压了一格）；`dictwalk.py` 末尾那段两层配置（不带标注与带标注各一份）三条腿与
  python3 逐字节相同。

* **默认值写成模块级的常量**（`RATE = 0.08` 上头、`def f(x=RATE)` 下头 —— 真的 python
  代码里这比写字面量还常见）。从前这一档当场报"默认值只收字面量"。
  收它**不用等新机器**：默认值是调用点展开的，那就展开成**那个名字背后那棵字面量**。
  这与 python 一模一样 —— python 的默认值是 `def` 那一刻算一遍、以后共享同一格，
  往后再改那个模块级的名字也换不动已经算好的那一格；展开成字面量正是这条。
  收的那一格窄得能说清：**模块级、只赋过一次、赋的是不可变字面量**
  （`collectConstGlobals` 收，`calleeSig` 的 `defs` 那一列替换）。
  "只赋过一次"是为了知道 `def` 那一刻算出来的是哪个值 —— 赋两回就说不清 `def` 排在
  哪一回后头，那时照旧当场报。
  判据：`kwargs.py` 里新添的那四句（常量当函数默认值 / 当方法默认值 / 负数那一格 /
  调用点再把它覆盖掉）三条腿与 python3 逐字节相同。
  **明说的不足**：可变的默认值（`def f(xs=[])`）还是当场报，这一条不是缺机器而是
  **语义真的不一样**（python 那一格是跨调用共享的）；算出来的默认值（`def f(x=g())`、
  `def f(x=A+B)`）也报 —— 展开成表达式会在每个调用点各算一遍，与 `def` 时算一遍差得出来；
  带 `{}` 的串（f-string）当默认值也不收（同一条：那是算出来的）。

* **尾随逗号那一整族**（`[1, 2,]` / 多行字面量 / `{…,}` / `f(a, b,)` / `def f(a, b,)`）。
  真的 python 代码里这几乎是默认写法 —— 格式化工具（black / ruff）一律往多行的最后一格
  加那个逗号。从前**整族都读错**，症状还离得远：`[1, 2,]` 报"这一格表达式还没接：null"，
  `{…,}` 报"字典里的 `null`"，`def f(a,)` 报"形参里有 `null`"。
  根因不在 python 这一侧，在 **GLR 那一层的套模板**（`src/core/glr/driver.js` 的
  `applyTemplate`）：尾随逗号那一支的动作写的是**光秃秃一格 `$*1`**
  （`(-> (item-list ",") $*1)`），意思是"那格列表原样传上去"——外头没有列表可摊。
  可 `applyTemplate` 只认**列表里头**的 `$*k`，顶层那一格掉到"atom 照抄一份"那一句上，
  于是 `item-list` 变成一格叫 `$*1` 的原子，父模板 `(list $*2)` 摊不开它、留下
  `$notalist`，一路漏到 adapter 才报。**九门语法里有八门都这么写**（mojo / cpp / go /
  vlang / nim / freebasic / polydraw / python），所以这一格是修在核心里的：
  顶层的 `$*k` 与 `$k` 同一件事，只多一句"它必须是列表"。
  判据：`tests/glr/cases/mini.cases` 加的那两条（`g(1, 2,)` / `g(1,)` 出的树与不带那个
  逗号的逐字节相同 —— mini.grammar 的 `ArgList` 也补上了那一支，所以表的快照跟着多一条
  产生式、状态数不变）；`collections.py` 末尾那段（表 / 字典 / 多行 / 元组 / 实参 /
  形参 / 命名实参七种写法）三条腿与 python3 逐字节相同。
  顺带说清这一刀**开了多大的口**：所有借这条路的语言的尾随逗号一起活了。
  **明说的不足**：`xs[1,]` 我们当 `xs[1]` 讲，而 python 那是**元组下标**（对表是 TypeError）
  —— 下标位置的尾随逗号与字面量那几处不是一件事，那一格等元组下标真要用时再说。

* **空容器装什么，答案在下一句里 —— 收的不止 `.append`**。
  `xs = []` / `d = {}` 自己答不出类型，这一层的办法是"赋值那一句先不绑，等走到用它的
  那一句"。可从前那一处**只认两种写法**（`xs.append(v)` 与 `d[k] = v`），于是
  `xs.extend(ys)` / `xs.insert(i, v)` / `xs += ys` / `d.setdefault(k, v)` /
  `d.update(other)` 开头的那几种（同样常见）一律撞在"推不出来 —— 给它一格标注"上。
  现在抽成一处 `fillTyOf`：那几种"往里放东西"的写法都说得出它装什么，只认**当场答得出
  类型**的实参，答不出照旧报（别猜）。`+=` 那一格在 `scanBinds` 的 `augassign` 那一支上
  （与 `.extend` 是同一件事，写法不同）。
  判据：`listmut.py` 末尾那段六种开头三条腿与 python3 逐字节相同。
  **明说的不足**：`d |= other` 还不收（方言那一侧没有"两张字典合起来"那一格算子）；
  `xs = []` 之后第一句是把它**递出去**（`f(xs)` 而 f 的形参没标注）那一档照旧要标注。

* **按键排序时键是一格元组**（`key=lambda kv: (-kv[1], kv[0])` —— "先按次数降、再按名字
  升"这种写法在真代码里到处都是）。**这一格从前静静地排错**：按键比大小落成方言的 `<`，
  而键是一格元组记录 —— 比的是**句柄**。与"排一串元组"那一刀同一个根（记在账上那条
  "凡是落到方言里没有这一族算子，先问它现在在比什么"），只是那一刀修的是元素、
  这一刀是**键**。
  改的是 `sortByKeyStmts` 与 `pickByKeyOf` 两处：**"怎么比"从外头递进来**
  （`cmpOne('<', …)`，元组走逐格比）。`sortByKeyStmts` 顺带跟着 `sortStmts` 一起
  把比较从 `while` 的条件搬到体里、加一格"还往前挪吗"的标记 —— 元组的比法自带几格 `let`，
  摆在条件位上会被提到循环外头（那正是元组排序那一刀量到的病）。
  两处的比都用**严格**的：排序稳定、min/max 平手留先出现的那一格，与 python 一致。
  判据：`listops.py` 末尾那段（`sorted` / `reverse=True` / `.sort` / `sorted(d.items())` /
  `max` / `min` 六种写法，键都是元组）三条腿与 python3 逐字节相同。

* **一格样品：库函数当真函数编（str 的补宽度那四格）**。这一刀的价值在**机制**与它顺手
  修掉的那处答错，**不是**"开始一格一格把库搬过来"—— 那条路线在 §一之二 里已经否掉了
  （运行时整份借，库函数不自己写）。这四格留着当样品，不再长。
  落的东西三处：
  - `ext/python/lib/str.py` —— `_str_ljust` / `_str_rjust` / `_str_zfill` /
    `_str_center`，**用 python 自己写**（46 行，换掉的是 JS 里约 70 行拼 IR 的代码）。
  - `ext/python/adapter/pylib.js`（102 行）—— 读那几份源码（`C.parseExpr`，同一张语法表，
    python 的起始规则就是 `module`）、`def` 摆进 `C.fnNodes`、外加**唯一**那张名字表
    `LIB_METHODS`。
  - 三处查同一张表：`methodOf`（发射成一次真调用，实例走 `resolveFn`）、`methodType`
    （交什么类型**问那一份的 `return`**，不再在表里抄一遍）、`collectInsts`
    （库函数的调用点在 CST 里长的是"方法"的样子，所以按那张表认，少给的按默认值补）。
  **机制里有两条以后接借来的运行时也要用的**：一是"**没人用的一格不发**"
  （单态化按调用点收实例；库里那几格**不许**退到 dyn 发出去 —— 它们的体是照着串写的，
  退到 dyn 当场报 `len()` 作用在 dyn 上）；二是**一张名字表三处共用**，
  发射 / 问类型 / 收实例不再各写一份名单。
  判据：`strmethods.py` 里那三行新的（center 的奇偶四种 / f-string 的 `:^` 两种 /
  **宽度是变量**的三种）加 `listmut.py` 原有那几行，三条腿与 python3 逐字节相同；
  python 套件 75 过 0 败。`emit sx` 上看得见 `(fn _str_zfill ((s string) (w int)) string …)`
  与 `(call _str_zfill …)` —— 是真函数，不是铺开的。
  **顺手修掉一处答错**：`.center` 多出来那一格填在哪边要看 `marg` 与 `width` 的奇偶
  （CPython 的 `left = marg // 2 + (marg & width & 1)`），从前按"多的在左边"写，
  六种里错三种（`"a".center(6,"*")` 答 `***a**`，python 是 `**a***`）。
  **顺手去掉一处凭空的限制**：`.center(w)` 从前要求 w 是整数字面量。

### 下一刀，按顺序

0. **把运行时真借进来**（§一之二 那条路，这一刀在别的之前）。三小步，每一步都有判据：
   a. **定值的表示**：`PyObject *` 打通到底（倾向这个），还是边界上转换。两边的代价写在
      §一之二。定下来之前不许再往"自己写一份库函数"那个堆上加东西。
      **别拿 `str(float)` 当这一格的样品** —— 那一格量过了（§一 第 23 条 (b)）：三条腿与
      python3 在 200 + 2032 个数上逐字节相同，接借来的 dtoa 买不到正确性。样品要挑
      **我们手上没有的那种**（`.zfill` 那一族、大整数、正则）。
   b. ~~**编进来**~~ —— **这一小步落了**（2026-09-28，见 §一 第 19～22 条）。当时写的卡点是
      "C 前端要有原子操作，`unicodeobject.c` 卡在那一格"；两条路里选了第一条
      （`scope.js` 给 `-D_Py_USE_GCC_BUILTIN_ATOMICS=1` + 补 `__atomic_*` 那一族），
      现在 `Objects/unicodeobject.c` 编出来是一份 1.4MB 的 `.o`，`py:sweep` **201/201**、
      `py:link` **0 缺口**、`py:freeze` 真跑一趟 **26/26**，整个解释器也跑得过真脚本。
      所以这一刀剩下的只有 (a) 那个表示的决定与 (c) 那一格样品。
   c. **一格走通两条腿**：拿 `.zfill` 当样品 —— adapter 发的是"调 `unicode_zfill`"，
      `omni build` 出的原生程序与 `--mode js`（C → MIR → JS）**都**与 python3 逐字节相同。
      这一格立住，剩下的就是按族替换（每族一刀，旧路那一族当场删掉）。
      **C 那一半立住了**（2026-09-28，§一 第 24 条）：手写的 C 过我们自己的 C 前端、与那 202 份
      `.o` 链一起，`zfill` / `center` / `7**80` / `repr(0.1+0.2)` 四格与 python3 逐字节相同
      （`npm run py:embed`）。**方言那一半也立住了**（§一 第 25 条，门三）：一份 `.sx` 走
      `(lib …)`+`(cabi …)`+`(ccall …)` 过 `omni build`，产物里带着借来的运行时、答案与
      python3 逐字节相同。所以剩下的是**adapter 自己发那三格**（`lower/sx.js` 里
      `ccall/lib/cabi` 三个构造器都在）、**出串那一格**（薄皮或 Builtin，见第 25 条），
      以及 JS 腿那一半（同一份 C 走 C 前端 → MIR → JS）。

1. **箱子里的函数拆出来调**（`(asfn …)` 那一格 —— 于是 `f = g` 之后 `f()` 走得通，
   与 lua 的元表同一条路）。`asfn` 要多给一格签名（箱子里只记着"这是函数"），
   所以 adapter 得先知道那一格该是什么签名。
2. **字典的键收 dyn**。键那一侧现在只收 int 与 string（`(dict K V) 的键只能是 int 或
   string`），所以"同一个循环变量走两张键类型不同的字典"那一条挡在这儿。
   删那一格已经开了（`ddel`，见上）。
   —— 这一格与第 0 刀有关：走 `PyObject *` 那条路的话，键的类型这件事自己就没了。

3. ~~**把借来的那份 `libomnipy` 用 ffi 接进来**~~ —— **这一条作废了**（2026-09-27）。
   它当时的卡点是"`cabi` 的类型词里没有出串那一格"与"`ccall` 在 JS 腿上要 N-API
   扩展（ADR-0038），接上之后 `omni run` / `--mode js` 会退档"。那两条都是
   **按"外部共享库 + ffi"想出来的**；按 §一之二 那条路（**把那几份 `.c` 用我们自己的
   C 前端编进同一个产物**，JS 腿从同一份 C 出）根本没有 ffi，也不退档。
   真要做的事并进上面第 0 刀。
4. **再借两格**：`Objects/longobject.c`（大整数 —— 现在的 int 是 64 位，python 的没有上界）
   与 `Modules/_sre/`（正则）。这两格都在第 0 刀 (a) 那个决定的下游：走 `PyObject *`
   那条路，"借来的东西怎么持有对象"这件事自己就有答案了（引用计数是它自带的）。
5. **`try` / `with` / `match` / 生成器 / 闭包 / 装饰器** —— adapter 现在对它们当场报
   "还没接"，不猜。


## 三、口径

- 版本钉在参考树上（现在 3.16.0a0），不钉本机装的那个 python。那棵树里已经有
  PEP 810 的 `lazy import`（标准库 71 份在用）、PEP 798 的 `[*i for i in xs]`、
  PEP 758 的 `except A, B:` —— 本机的 3.13 没有这些。
- 软关键字（`match` / `case` / `type` / `lazy`）进关键字表，再从语法里的 `sname`
  那一条当普通名字放回去。理由与代价写在 `python.grammar` 的关键字段。
- 语法**收得比 python 宽**几处（海象出现在语句位、match 的模式借表达式语法）。
  "解析不是校验" —— 那几格由 adapter 判并当场报，不由语法判。
