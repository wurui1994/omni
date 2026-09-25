# ADR-0046：`omni c split` —— 按声明切分 C 源码，且能逐字节复原

状态：**已定，准备落地**（2026-09-25）

## 1. 要解决的问题

`polydraw-bench` 那棵工作树上要做的第一件事，不是改代码，是**把原始代码拆开**：
`polydraw_src/` 只有三个文件，其中 `eval.c` 6122 行 / 238KB、`polydraw.c` 3661 行 / 148KB。
一个人（或一个 agent）没法在这种粒度上安全地移植它到 arm64。

约束是用户定的，一条比一条硬：

1. **不许动原始代码**。拆分是"把同样的字节分到几个文件里"，不是重写；
2. **基于 AST 拆**（不是按行数、不是正则找 `^}`）；
3. **能完美复原**：把拆出来的片段按记录的次序接回去，**逐字节等于原文** ——
   注释、空行、`#if 0` 里那段 nmake 头、行尾的 CRLF 全都要在；
4. **要说得清哪个函数去哪个文件与头**；
5. 这是 **omni CLI 的一项通用能力**，先做 C —— 不是给 polydraw 写的一次性脚本。

第 3 条是这份设计的支点：**有了逐字节复原这把尺子，"拆得对不对"就是一句可执行的话。**

## 2. 关键决定：**用 AST 定边界，用原文的字节做内容**

拆分**不重新打印** AST。打印出来的 C 与原文永远不会逐字节相同（注释没了、
空白变了、`1e3` 变 `1000.0`），而那正好是第 3 条禁止的。

所以：

* **解析只负责回答"顶层声明从第几个字节开始、到第几个字节结束"**；
* 每一格产物是原文的一个**闭区间切片**，`split` 只做 `slice` 与 `concat`。

于是第 3 条不是"努力做到"，而是**结构上成立**：全部切片是原文字节的一个**划分**
（partition，不重不漏），复原就是按次序接起来。判据里那一句
`Buffer.concat(pieces).equals(original)` 是硬线。

### 2.1 一格切片长什么样

```
chunk = { file, kind, name, start, end, lead }
```

* `lead` 是**前导填充**：上一格结束到这一格开始之间的所有字节 —— 注释、空行、
  `#define`、`#if/#endif`、`extern` 声明块。它**跟着后面那一格走**（一段注释描述的是
  它下面那个函数，这是 C 代码的通例，也是让"函数带着它的注释一起搬家"的唯一办法）；
* `kind` ∈ `func`（有体的函数）/ `proto`（只有声明）/ `var`（全局量）/ `type`
  （typedef / struct / union / enum）/ `pp`（顶层预处理指令自成一格）/ `skip`
  （`#if 0` 那种被跳过的整段）/ `tail`（最后一格之后剩下的字节）；
* `name` 是那一格定义的符号名（`func`/`var`/`proto`/`type` 才有）。

### 2.2 为什么必须在**原始 token 流**上扫，不能预处理

`polydraw.c` 头 8 行是 `#if 0` 包着的 nmake 脚本。预处理之后那一段**不存在** ——
拿预处理后的 token 定边界，复原时那 8 行就丢了，第 3 条当场破。
所以扫描器吃的是 `tccpp` 的**词法层**（`tccpp.js` 那一半），
把 `#...` 整行当一格 token 收下、`#if 0`/`#if 0`+`#else` 这种整段收成 `skip`，
**不做宏展开、不查头文件**。

顺带一个好处：这条路**与平台无关**。`windows.h` 在这台机器上不存在，
但拆 `polydraw.c` 不需要它 —— 拆分只看语法，不看语义。

### 2.3 这是对"我们的 C 解析能力"的一次真考试

用户的原话是"omni 检测完善 c 的解析能力"。这件事在这儿是**判据**而不是口号：
扫描器必须把 6122 行的 `eval.c` 从头走到尾，**每一个字节都落进某一格**，
一格 `unknown` 都不许剩。走不过去的地方就是我们 C 前端的缺口 —— 补它，不是绕它。

## 3. 谁去哪个文件：**描述文件就是那份规划**

用户的话："切分是一种描述文件。根据描述文件，会生成很多文件。那些函数在哪个文件，
描述要清楚。不是随便分为一类。"

所以流程是三段，中间那一段是**人做的规划**，不是启发式的输出：

* `omni c split --scan FILE.c`：印出**清单**（每一格顶层声明：种类、名字、行号、字节数）。
  这一步只是把家底摊开，不作任何分类判断；
* **人照清单写描述文件** `FILE.split`（签进仓库）。格式一行一格：
  `目标文件<TAB>种类<TAB>符号名<TAB>行号`（`#` 开头是注释，允许分节小标题）。
  **每一格都要有一行** —— `--map` 见到没被指派的格子就报错退出，不给"默认扔哪儿"这种口子。
  行号是**消歧用的**：同名的格子（`eval.c` 里两个 `kasm87err`、四个 `rdtsc64`）靠它区分；
* `omni c split --map FILE.split FILE.c -o DIR/`：照描述文件切，并生成头。

### 3.1 `eval.c` 的规划（6122 行 -> 9 个模块）

依据三条，按优先级：**作者自己划的段落**（`eval.c:239` 那行
`//---- KASM87 BEGINS ----`、`:5548` 的 `KASM87 ENDS`）、**职责**（解析 / 优化 / 发码 /
解释执行是四件事）、**引用关系**（只被某一族用到的表跟着那一族走）。

| 目标文件 | 装什么 | 为什么是它 |
| --- | --- | --- |
| `eval/kasm_cpu.c` | `testflag` `cpuid` `getcputype` + `round0msk` `cpuinited` | `:387-456`，CPU 特性探测，谁都不依赖 |
| `eval/kasm_math.c` | `ksrand` `krand` `nrnd` `fact` `kpow` + `snormstat` | `:464-630`，**JIT 发出来的码要 call 它们**（运行时助手），与编译期无关 |
| `eval/kasm_state.c` | 九个 `typedef`（`rtyp` `gasmtyp` `patch_t` `jumpback_t` `newvartyp` `initval_t` `kcd_t` 等）+ 全部全局表（`gasm` `rxi` `patch` `jumpback` `globval` `gstring` `newvar*` `enum*` `newlab*` …）+ 十四个 `check*` 增长函数 | `:250-386` 与 `:940-1052`。这一族是"数据结构与容量管理"，**没有一行发码**；把它单独拿出来，后面三个模块才可能各自独立 |
| `eval/kasm_parse.c` | `isvarchar` `getnewvarhash` `gasmeq` `skipparen` `findscope` `parse_dimensions` `parse_enum` `parse_static` `parsefunc`(45KB) | `:916-2548`。源码 -> `gasm[]` 那一半 |
| `eval/kasm_opt.c` | `anyreadsbeforewritesrec` `anyreadsbeforewrites` `kasmoptimizations`(24KB) + `anyreads1stinst` | `:2640-3332`。在 `gasm[]` 上做峰孔，输入输出都是那个数组 |
| `eval/kasm_emit.c` | `put1byte` `put2byte` `put4byte` `putsib` `putlen` `put1stfld` `kasm87comp`(62KB) `setecurs` `kasm87`(16KB) `kasm87_findfirstfuncparen` + `fpustat` `putwrite` `compcode` | `gasm[]` -> x87 机器码那一半。**ADR-0045 要照抄的就是这一格** |
| `eval/kasm_interp.c` | `kasm87c_run`(12.5KB) `kasm87cp` `kasm87c` `kasm87c_copyglob2struct` + `gkasm87cptr` | `:3333-3600`，`COMPILE == 0` 那一档（不发码、直接解释 `gasm[]`）。与 `kasm_emit.c` **互斥**，正好是我们"没有 JIT 时的备选"要读的那一份 |
| `eval/kasm_api.c` | `kasm87addext` `kasm87free` `kasm87freeall` `kasm87jumpback` `kasm87_showdebug`(4.3KB) `getfuncnam` `getvarnam` + `kasm87err*` `kasm87leng` `kasm87optimize` | 对外那一层 + 调试打印。`eval.h` 里声明的就是这一批 |
| `eval/eval_test.c` | `KASM87 ENDS` 之后的全部：`rdtsc64`×4 `dumpfp` `testcode` `getdigpi` `getdiggoldrat` `getangle360` `func4d` `sndfunc` `mysrand` `printnum` `crossprod` `printst` `main`(10.7KB) + `pilut` `goldratlut` `buf3_2` `debuf`，以及文件头尾那三段 `#if 0` | `:5548` 之后是 Ken 自己的**独立测试程序**（`main` 在这儿）。它不该编进 polydraw —— 拆出来之后这件事第一次变得明显 |

头两份：

* `eval/kasm_int.h`（**内部**）：九个 `typedef` + 全局表的 `extern` + `check*` 与
  跨模块用到的 `static` 去掉 `static` 之后的声明。上面六个 `kasm_*.c` 都 include 它；
* `eval.h`（**对外**，原文那一份）：**一个字不改**。它已经是"外面看 eval 的那张脸"。

`mysrand` 那一格注意：它在 `eval.c` 与 `polydraw.c` 里各定义一次（原版就这样，
靠 `/FORCE:MULTIPLE` 链过去）。拆分**不动这件事** —— 它落在 `eval_test.c` 里，
而 `eval_test.c` 不编进 polydraw，于是那个 `/FORCE:MULTIPLE` 反而**可以去掉**了。
这是拆分的副产品，记一笔，但不在这次提交里改 `build.cmd`。

### 3.2 `polydraw.c`（3661 行 / 133 个函数）与 `kplib.c`（231 格 / 77 个函数）

同一条路：作者在 `polydraw.c` 里用 `//---------` 划了 12 段（`:370` `:423` `:469` `:529`
`:711` `:855` `:964` `:1706` `:1722` `:1742` `:2726` `:2870`），那 12 段就是第一版的
模块边界；`kplib.c` 是 Ken 的公共库（PNG/JPG 解码 + ZIP + 位图），按它自己的
`kp*` / `kz*` / `kpeg*` / `kpng*` 前缀分。这两份的描述文件在 `eval.c` 那份过了判据之后再写
—— 一次只动一份，判据才说得清是谁的问题。

### 3.3 头文件怎么生成（唯一"打印"而不是"抄"的地方）

* 模块里的 `static` 一律不出现在头里（它本来就是私有的）；
* 非 `static` 的函数与全局量，**只有被别的模块引用到**才进头 ——
  引用关系是扫描器给的，不靠人记；
* 头里那一份声明是从原文**抄声明符那一段字节**（`start` 到形参表的 `)`）再补 `;`，
  不是重新打印类型 —— 所以 `double (*f)(double,...)` 那种形状不会被我们的类型打印器改写；
* 每份头带 `#pragma once`，与原文风格无关（它是新材料）。

**共享的 `struct`/`typedef`/`#define` 是个真问题**：它们在原文里散落在 `.c` 的中间。
这一版的规矩是：清单里可以把一格 `type`/`pp` 指到 `模块名.h` —— 那一格的字节
**整块搬进头**（连注释一起），`.c` 里不再留副本。复原时它照旧按原次序接回去，
所以第 3 条仍然成立。

## 4. 判据（三条，缺一不可）

1. **逐字节复原**：`omni c split --check DIR/` 把 `DIR/split.manifest` 记的次序接起来，
   与原文 `Buffer.equals`。**这一条是硬线**；
2. **划分完整**：扫描器报的切片区间必须是 `[0, len)` 的一个划分（不重不漏）。
   这一条在 `split` 内部 assert，不靠外部判据；
3. **拆完还能编**：在 Windows 那台机器上 `bench\build.cmd`（改成编拆出来的那一批 .c）
   出来的 `polydraw.exe` 能跑 `/bench:N`，**fps 与拆分前在同一个噪声带里**。
   这一条要那台机器，所以它是"提交之后第一件事"，不是本地门槛。

本地还要加一格便宜判据：`tests/c/split/run.js` —— 拿我们自己仓库里几份 `.c`
（`src/runtime/omni_fmt.c` 那种真实尺寸的）过一遍 `--check`。这一格是为了把
"C 解析能力"的缺口暴露在**我们自己的代码**上，而不是等 polydraw 报错。

## 5. 落地次序

* **S1**：扫描器 + `--check`（不切，只证明能划分与复原）。判据：`tests/c/split`；
* **S2**：`--plan` 出清单；人过一遍，签进 `polydraw_src/split.map`；
* **S3**：`--map` 真切 + 生成头；`polydraw-bench` 上作为**第一次提交**
  （提交信息里写清"字节复原已验"）；
* **S4**：开始 osx arm64 那件事（ADR-0045 的 D1 起）。

## 6. 不做的事

* **不做完整 C AST**。这一版只要顶层边界；函数体内部**一个字节都不解析**
  （体是按花括号配对找到的 —— 字符串、字符常量、注释里的花括号要跳过，
  这三样正好是词法层的事，所以这条路不欠什么）；
* **不做 C++**。名字 mangling 与模板会把"抄声明符那一段字节"这招毁掉；
* **不改原文一个字节**。`split` 只有 `slice`/`concat`/生成新头三种动作。
  连 `#include "xxx.h"` 那一行都不往原文里插 —— 它进的是**生成的头**与
  每个模块新加的第一行（那一行属于新材料，不在复原的那张清单里，
  `--check` 时按 manifest 里记的 `synth` 标记跳过）。
