# ext/r —— R（GNU R）

**状态**：语法读下 R 自己那棵树里 **958 份 `.R`／`.r` 全过**（4 份挑出来不算，理由在
`bench.json`）；映射接了 **10 个家族**，每一份逐字节对本机 `Rscript`；
**数值那一半由 R 自己的 C 代码答** —— `r-source/src/nmath` 的 121 份 `.c` 由我们的 ninja
编成 `libomniRmath`，走自动 FFI 在 JS 上调。

四条命令，四把尺子：

```
node ext/r/build.js           # R 的 C 运行时：121 份 .c + 三份生成的头 -> libomniRmath
node bench/grammars.js r      # 语法：建表 + 语料通过率
node tests/lower/run.js "r+"  # 映射：八个家族的输出与别的十一门一致
node tests/r/oracle.js        # 正确性：逐字节对 Rscript + gram.y 的漂移守卫
```

**不带一个 R。** 跑起来的东西里没有 `libR`、没有 R 的解释器、没有 R 的包 ——
输入只有那棵源码树与一台 C 编译器。`Rscript` 只在**判据**里出现（一把尺子），不是运行时依赖。


## 一、语法的正本是 R 自己那份 bison

`~/Documents/Lang/reference/r-source/src/main/gram.y`（R 4.7.0-devel）。那份 `.y`
**我们本来就读得动**（ADR-0034 的导入器）：

```
omni glr y     <参考树>/src/main/gram.y   # 转成 (grammar …) 正文
omni glr table <参考树>/src/main/gram.y   # 74 终结符 / 93 条产生式 / 173 状态
```

所以 `r.grammar` 不是手抄的，是照着转出来的文本改**四处**。四处都有根因，逐条写在
`r.grammar` 文件头，这儿只列标题：

1. **一条候选式一个标签** —— CST 里没有记号类别（`glr/driver.js:356` 移进时只留 `tk.node`）。
   二元算符那一族反过来刻意共用 `bin`、算符文本走 `$2`：那正是 R 的 `xxbinary($2,$1,$3)`。
2. **词法自己写** —— R 的词法是那份 `.y` 第二个 `%%` 之后的手写 C，不是 `.l`。
3. **顶层多一条 `program : exprlist`** —— R 的 `prog` 是"一次一条"，C 那侧循环调用 parser。
4. **`eaoh -> expr` 挂 `(prec LOW)`** —— 那 28 处移进/归约冲突 R 那份也有，bison 默认移进；
   GLR 这条路上"默认"不存在，两支都活着就报歧义。说出来，不靠默认。

剩下的 36 处冲突全是 `%nonassoc GT GE LT LE EQ NE`（`a < b < c` 在 R 里就是错的）——
与那份 `.y` 同一格。

### 换行：这门语言唯一难的一格

R 那侧是 `EatLines` 加一个 `contextstack`（`gram.y:3826–3904`），换行切出来之后问三件事。
三问一一对上 `(auto-semi …)` 的三格：

- 「上一个记号把表达式说完了吗」→ `after …`（就是 `gram.y:3978–3986` 那张 `EatLines = 0` 的名单）
- 「现在在不在 `(` / `[` 里」→ `(brackets …)`，**栈不是计数**：R 判的是**栈顶**，
  所以 `{` 要用 `(brackets-clear "{}")` 入栈（盖住外面那层 `(`）却不压住补分号。
  计数版在这批语料上量过：958 份从 940 掉到 **728**。
- 「往下看一眼是不是 `else`」→ `unless-before "else " "else{" …`，**必须带后面那一格**：
  光写 `"else"` 会按前缀撞上 `else.expr` 这个真名字（`src/library/compiler/R/cmp.R`）。

为此在 `src/core/glr/lex.js` 上加了两样**通用**的东西（别的语言不声明就一个字节不受影响）：
`(auto-semi … (brackets …) (brackets-clear …))` 与模式项 `(until "关")`。后者是这套贪心
不回溯的匹配器里唯一的非贪心项 —— R 的原始串 `r"{…}"` 内容里真有单个 `}`
（`(?:…){0,2}` 这种正则），要扫的是**两个字符**的 `}"`。

### 语料量到的（`node bench/grammars.js r`）

958 份全过。挑出去的 4 份是**本来就不该读得下来**的，一份一份挑（不按目录一刀切）：

- `tests/Pkgs/PR17859.1/R/f2.R`、`PR17859.2/R/f2.R` —— 为 PR#17859 造的包，文件里自带
  `## parse error .... unexpected symbol`
- `tests/Pkgs/PR17859.2/R/f3.R` —— 开头那个 `}` 的配对留在上一个文件里（`## to be continued`）
- `tests/utf8-regex.R` —— 不是脚本而是一段**交互记录**：它 `readLines(n = 2)`，
  紧跟的两行是喂给标准输入的 Latin-1 数据

一路上修掉的四个真缺口（都不是"多写一条规则"，都是根因）：

1. `\f`（换页）也算空白 —— `src/library/base/R/New-Internal.R` 里真有一个单独占一行的。
2. 反引号名字里的**反斜杠转义**（`` `\`` ``，`tests/reg-tests-1c.R:303`，PR#15621 的回归用例）。
   写成普通 token 的话那个转义的反引号当成收尾，**从那儿起整份文件的引号奇偶性就反了** ——
   症状出现在 167 行之后的一句注释里，根因一点不明显。改用 `(string SYMBOL "`")`。
3. 括号里的换行（见上）。
4. 原始串的收尾（见上）。

## 二、R 的 C 运行时（`ext/r/build.js` + `rt/`）

数值那一半**不由我们答**。`round(0.5)` 在 R 里是 `0`（到偶）、`round(2.675, 2)` 是 `2.67`、
`-7 %% 3` 是 `2` —— 这些不是"我们算错了"能修的东西，它们就是
`r-source/src/nmath/fround.c` 那段代码的行为。所以：

```
r-source/src/nmath/*.c  ──ext/r/build.js（我们那份纯 JS 的 ninja）──> libomniRmath.dylib
生成的 Rmath.h ──rt/ffi.js（cap('c.declsOf')）──> (cabi …) ──backend-js/cffi.js──> N-API
```

三份头自己生成（`rt/gen-config.js` 探本机写 `config.h`、跑 R 自己的 `tools/GETCONFIG`
出 `Rconfig.h`、`rt/gen-rmath.js` 替 `Rmath.h0.in`）—— **不借本机装的那个 R 的任何东西**：
它的 `Rmath.h` 是 4.6.1 的，而这棵树是 4.7.0（四份 bessel 要新宏）。裸 clang 直编是
113/120 过，三份头一上是 121/121。

签名**不手抄**：`rt/ffi.js` 拿 `cap('c.declsOf')` 从生成出来的那份 `Rmath.h` 读出 271 条
声明（与 jnc 的 `import "lib" with "h.h"` 同一条路）。`ext/r/adapter.js` 的 `RMATH` 表只说
"R 的这个名字对应那边哪个符号、缺的实参补什么"，而且每次调用都核一遍元数 ——
那一格是**这张表与那棵源码树之间的锁**（R 改了某个函数的形参个数，这儿当场报）。

接了的：`round` `signif` `trunc` `sign` `pmax` `pmin` `gamma` `lgamma` `digamma` `trigamma`
`beta` `lbeta` `choose` `lchoose` `log1p` `expm1`、`^`（`R_pow`）、
`dnorm`/`pnorm`/`qnorm` 与 `dbinom`/`pbinom`/`dpois`/`ppois`/`dgamma`/`pgamma`/`dbeta`/
`pbeta`/`dt`/`pt`/`dchisq`/`pchisq`、`besselI`/`besselJ`/`besselK`/`besselY`。

libm 那一族（`sqrt` `exp` `log` `log2` `log10` `floor` `ceiling` 与三角/双曲）落方言的
`rmath` —— R 自己这几个也是直接调 libm，不在 nmath 里。`log(x, base)` 那种两格的**当场报**：
那一档要我们替它算（`log(x)/log(b)`），而"替它算"与"照它算"是两件事。

`NaN` / `Inf` / `-Inf` 三格真值由**我们自己那份** `rt/omni_rna.c` 给（R 那边它们在解释器里）；
`is.finite` 用 R 自己的 `R_finite`。印法照 R 的三处特例（`NaN` / `Inf` / `-Inf`），
布尔印 `TRUE` / `FALSE` —— 都在生成出来的那格 `r_num_str` 里，用到才发。

### `NA` 落不下来 —— 量出来的，不是没接

R 的 `NA_real_` 是"一个带 1954 载荷的 NaN"（*R Internals* §1.3）。那个载荷：

- 在 C 里**好好的**：`rt/omni_rna.c` 编出来直接调，`is_na=1 is_nan=0`；
- 在 JS 的 `number` 里也**好好的**：从 `Float64Array` 读出来再写回去，低 32 位还是 1954；
- **过一趟 N-API 就没了**：`(ccall omni_r_na)` 拿回来的值再交回 C，`is_nan` 变成 1 ——
  `napi_create_double` 要把 double 装成一格 JS 值，那一步 V8 把 NaN 规范化了
  （ArrayBuffer 那条路没这一步，所以第二条成立）。

于是 `NA` 与 `NaN` 在这条腿上**分不开**。硬接的后果是 `cat(NA)` 印 `NaN`、`is.nan(NA)` 答
`TRUE` —— 两句都是静默的错答案，比报出来糟得多，所以 adapter 遇到 `NA` 当场报。

要它就得让 R 的值**不是一格裸 double**（tag 在 double 外面）。这一条正是"向量与值模型"
那一版绕不过去的理由 —— 它不是一格函数能补的。

**随机数那一族（`r*`）刻意没接**：它们要 `set.seed` 那套状态，而 R 的发生器在解释器里，
standalone 这一份的流不一样 —— 接上去是"看着像对、每个数都不一样"。

`%%` 与 `%/%` 是**按 R 文档的定义自己写的**（`x - floor(x/y)*y` / `floor(x/y)`）：
R 的 `myfmod` 在解释器那半边（`src/main/arith.c`），不在 nmath 里。写出来的口径与 R 一致
（随除数取号），但它是我们的实现，不是它的代码。

**许可**：仓库里不落任何 R 的代码 —— 只有构建规则与两个生成器，源码从参考树读。
与 `ext/awk` 不从 gawk 的 `.y` 派生、而是用导入器现场读同一条规矩（这个仓库是 MIT）。

## 三、映射接了什么

八个家族：`basics` `intmath` `loopexit` `unary` `strcat` `numstr` `dict` `index`。
adapter 自己消化五件事（`ext/r/adapter.js` 文件头有账）：

1. **函数是值** —— `f <- function(n) …` 是一格赋值，顶层扫一遍提升成 `fn`。
2. **最后一句就是返回值**，而 `return(x)` 在 R 里还是一次**调用**。尾位上的 `if` 要往
   两支里钻，不能囫囵包成三元：`if (n == 0) return(1)` 只有一支带值。
3. **没有声明** —— `acc <- 0` 既是赋值也是第一次出现（与 awk 同一格），段顶补一串 `let`。
4. **类型** —— 方言那层不推导只检查。R 的数其实只有 double，这儿按**字面量的写法**分：
   `5` / `42L` / `1:n` 是 `int`，带小数点或指数的是 `real`。判据是例子的输出
   （`cat(15)` 要印 `15` 而不是 `15.0`）。
5. **下标从 1 起** —— `x[i]` → `aget(x, i-1)`，字面量当场折掉。`x[["k"]]` 是字典
   （R 的 `list` 带名字用就是关联表），`x[i]` 是数组 —— 靠第 4 条推出来的类型分。

一格 `hooks` 都没有：`aset` / `dset` / `aget` / `dget` 由 adapter 直接发（它知道类型），
`cat` 落成一串 `write`（**不是 `print`**：方言的 `print` 自带换行，R 的 `cat` 不带，
差一个字节就对不上 `Rscript`）。

内建认得的只有 `ext/r/adapter.js` 里 `BUILTINS` 那一张表 —— 那是判据不是方便：R 的内建在
树上与用户函数完全同形（`length(x)` 与 `f(x)` 一个形状），分开它们只能靠名字，
所以"接了哪些"要有一处说法，而不是散在一串 if 里。

### R 独有的那一格坑

**`length(s)` 不是串长。** 它是"这个向量有几个元素"，对一格串回 `1`。串长要 `nchar(s)`。
adapter 按类型分：串上 `slen`、表上 `dlen`、别的 `alen` —— `unary` 那一族第三行压的正是它。

## 四、明说的不足（**不猜**）

1. **不做向量化。** R 里 `c(1,2) + 1` 是逐元素加、`if (c(TRUE,FALSE))` 是取第一格加一句
   警告 —— 这一批一律当标量算。这不是"以后补一格函数"的事，是整套值模型（长度回收、
   `NA` 的传播、属性）的事，得单独一版。
2. **不做懒求值**（promise / `missing()` / `substitute()`）—— 所以**形参默认值当场报**
   （`function(x, b = 2)`：R 里那个 `2` 是在函数体里才求值的一格 promise）。
3. **不做属性**（`names` / `dim` / `class`）、**不做 S3 / S4 / R5 分派**、
   **不做环境**（`<<-` 当普通赋值）、**不做 `...`**。
4. `NA` / `NaN` / `Inf` 认得出记号但落不下来 —— 方言里没有"缺失"这一格。
5. 语法层两处：带 `-` 的原始串（`r"---(…)---"`，两侧个数要相同，这套词法项表达不了）、
   非 ASCII 字母的名字（`alpha` 只有 ASCII）。
6. `a:b` 只在 `for (v in a:b)` 那一格接了 —— 拿它造向量要先有第 1 条。
7. **数的印法**：实数走 `%.7g` 再去尾随零（R 的 `cat` 对 double 的 `digits = 7`），
   但 R 在**定点与科学记数之间按哪个短**挑（`scipen`）那一格没做 —— 于是 `cat(1e5)`
   我们印 `100000` 而 R 印 `1e+05`、`cat(123456789)` 我们印 `1.234568e+08` 而 R 印
   `123456789`。那条挑法在 `src/main/format.c`（解释器那半边）。量过：要么整数、
   要么 ≥1e5 才碰得到。
8. 随机数那一族（`r*` / `set.seed`）没接 —— 见第二节。
9. **`NA`** 落不下来（不是"没接"）—— 根因与后果见第二节那一小节。
