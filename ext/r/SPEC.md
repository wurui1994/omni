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

### `NA`：R 的 double **按指针过 FFI，不按值**

`NA_real_` 是"带 1954 载荷的 NaN"（*R Internals* §1.3）。那个载荷在哪儿丢的，量出来三档：

- **C 里好好的** —— `rt/omni_rna.c` 编出来直接调：`is_na=1 is_nan=0`（对）
- **按值过一趟 FFI 就没了** —— `(ccall omni_r_na)` 拿回来再交回 C：`1 1`（NA 变成普通 NaN）。
  `napi_create_double` 要把 double 装成一格 JS 值，那一步 V8 把 NaN 规范化了。
- **按指针走就留住了** —— `(pnew (ptr real) 1)` + `(ccall … (var p))`：`1 0`；而且
  `pload` 出来那格 JS 数再 `pstore` 回另一段内存还是 `1 0`（JS 的 `number` 本身**不丢**载荷，
  丢的只是装箱那一步）。

所以这一族走 `(ptr real)`：值留在线性内存里，两边按位读写，绕开装箱。三格封在生成出来的
`r_na` / `r_is_na` / `r_is_nan` 里，调用点照旧写 `NA` / `is.na(x)` —— 指针那套不往上冒。
R 那两条区别由此立住：`is.na(NaN)` 真、`is.nan(NA)` 假。

`is.finite` / `is.infinite` 照旧**按值**过：`Inf` 没有载荷可丢。

### 由此定下的一条：**R 的向量不能用 `(arr real)`**

"载荷能存在哪儿"一路量下来还有第四格，它把向量那一层的表示定死了：

- `Float64Array` / 普通对象字段 / 局部量 / 混着别的东西的 JS 数组：载荷**留得住**
- **只装 double 的 JS 数组：载荷被抹掉** —— V8 的 `PACKED_DOUBLE_ELEMENTS` 会把 NaN
  规范化（那种数组里"洞"本身就是一个特殊 NaN，所以它必须规范化）

而后端把 `(arr real)` 落成的正是一个 JS 数组（`$anew` 出 `[]`）。所以 R 的数值向量得走
**线性内存**（`(ptr real)` —— `$pload_r` / `$pstore_r` 是 DataView 的 getFloat64/setFloat64，
按位进出）。这一格有判据守着（`tests/r/oracle.js` 第三节）：哪天 V8 不抹了那一行会红，
那时该去掉这条约束，而不是删掉判据。

### 向量的存法与逐元素那一层

```
槽 0      长度（按 double 存）
槽 1..n   元素
```

长度写在头上是 R 自己的做法（SEXP 的 header 里就有 length），而且这样一格向量就是**一个值**：
能当形参、能当返回值、能进字典 —— 换成"另开一个结构体装长度"就要多一份 `(struct …)`
与 `fld` / `fldset`。

`c(…)` / `length` / `x[i]` / `x[i] <- v` / `for (v in xs)` / `sum` / `mean` / `max` / `min`
都在这一层上，`+ - * / ^ %% %/% < <= > >= == !=` 逐元素并**按 R 的回收规则**对齐：
结果长度取长的那边，短的那边从头再来（`c(1,2,3,4) + c(10,20)` 是 `11 22 13 24`）。
`^` 逐元素也走 R 自己的 `R_pow`、`%%` / `%/%` 走那条 floor 的算法 —— 标量与逐元素**共用
同一处**（`numBin`），不然 `x^2` 与 `xs^2` 会算成两回事。

`c(…)` **摊平**实参里的向量（`c(1:3, 9, xs)`）—— 总长度是运行期才知道的，所以先把向量实参
存进临时量、按"标量算 1、向量问槽 0"加起来，再拿一格写指针填。

`a:b` 当值用也是一格向量：步长 ±1、两头都含，`b < a` 时**倒着数**（`1:0` 是 `1 0`，
不是空向量 —— R 里有名的一格坑）。`for (v in a:b)` 不走这条路，那边照旧落成计数循环
（不造向量），所以循环量在类型上仍是 int —— 这两处得对齐（`isRangeHead`）。

**下标也能是向量**：逻辑向量按掩码挑（`xs[xs > 2]`，掩码短了从头再来，掩码里的 `NA` 在 R 里
挑出一格 `NA` 而不是跳过），数值向量按位置挑（`xs[c(1,3)]`）。掩码那一格要两趟 ——
结果长度得在 `pnew` 之前数出来。`c(TRUE, FALSE)` 本身就是一格逻辑向量，而 `c(TRUE, 1)`
R 往数值那边收，所以"每一格都是逻辑"才算逻辑。

**一元与那一族数学函数也逐元素**（`vecMap1`）：`-xs`、`abs(xs)`、libm 那一族（`sqrt` /
`exp` / `log` / `floor` / 三角…）、以及 nmath 那一族（`round(xs, 1)` / `signif` / `dnorm`…）。
nmath 那一族**只在第一格实参上**逐元素，别的格先存进临时量（循环里要读好多遍）——
R 其实是多头回收的（`round(xs, c(1,2))`），那一格当场报，不假装。

进出都是向量的几格：`rev` / `seq_along` / `which` / `sort` / `cumsum` / `diff` / `range` /
`head` / `tail` / `rep` / `seq`；出一格数的几格：`sum` / `mean` / `max` / `min` / `prod` /
`var` / `sd`。`which` 回的是**位置**（数值向量），`NA` 直接丢 —— 与 `xs[m]` 不同
（那边 `NA` 挑出一格 `NA`），这两条口径是 R 自己分开的。

**缺失那一格每个函数的口径都不一样**，照 R 的文档办（判据是 `ext/r/examples/vecfn.R`）：
`sort` 把 `NA` **丢掉**（`na.last = NA` 是默认）、`max` / `min` / `range` **传下去**
（`max(c(1, NA))` 是 `NA` —— 按 `>` 比是躲不过去的：`NaN > x` 恒假会把 NA 悄悄跳过，
所以那一格每元素先问一句 `is.na`）、`cumsum` / `prod` / `var` / `sd` 按浮点自然传播。
`sort` 用的是 Shell 排序（Knuth 的 gap 序列）；R 自己用快排/基数排序，但**全排序的结果
是唯一的**（double 上相等的元素分不出来），所以两边逐字节一致。

`sort` / `head` / `tail` / `rep` 出来的**元素类型跟着进去的那条走**（逻辑向量排完还是逻辑）。
`xor` / `isTRUE` / `isFALSE` / `ifelse` 也接了：`xor` 逐元素三态、`isTRUE` / `isFALSE`
回的是**两态**（`isTRUE(NA)` 在 R 里是 `FALSE`，不是 `NA`）、`ifelse` 的形状随 `test`
（`yes` / `no` 按回收取）。

比较回的是**逻辑向量** —— 同一段线性内存，只在 adapter 这一侧的类型上多带一个记号
（`RLGL`，`typeToSx` 看不见它），差别只在印法：`TRUE` / `FALSE` / `NA`。
`NA` 那一档是真的走到底的：`NA > 2` 与 `NaN > 2` 都是 `NA`（不是 `FALSE`），
所以 `sum(c(1,NA,3) > 2)` 印 `NA` —— 判据在 `ext/r/examples/vec.R`。

**一格逻辑标量也是三态的**（`RLGL1`）：同样是 double 的 1.0 / 0.0 / NA，
只是不带指针。于是 `cat(NaN > 2)` 印 `NA`、`zs[1]` 印 `TRUE`、
`any` / `all` 回一格带 NA 的逻辑、`NA & FALSE` 是 `FALSE`（三态真值表的那两格反直觉的
在 `?Logic` 里），而 `if (NA)` 是**停下来**（方言的 `(fail …)`）而不是当假 ——
判据在 `ext/r/examples/lgl.R`。两边都是 int 的比较仍然回方言的 `bool`：
这一档没有 `NA_integer_`，那个状态到不了，而 `while (i <= n)` 是循环里最热的一格。

线性内存这条路顺带把**两条腿**都走通了：`omni run`（JS + N-API）与 `omni build`（C 后端，
`ccall` 直接连 `libomniRmath`）对 `vec.R` 的输出都与 `Rscript` 逐字节相同。

**`NA_integer_` / `NA_character_` 还没接** —— 它们在 R 那边是另外两种表示
（`INT_MIN` 与一格特殊的 CHARSXP），要"带缺失的整数/串"那一层。

### 随机数：与 R 同一条流

`r*` 那一族**接了**，而且数与 R **逐位相同** —— 判据是 `ext/r/examples/rng.R`
（`set.seed(42); runif(3)` / `rnorm` / `rexp` / `rpois` / `rbinom` / `sample` 两边一样）。

这一格原来刻意空着，理由是真的：standalone 的 nmath 自带的发生器
（`src/nmath/standalone/sunif.c`）是 **Marsaglia-MultiCarry**，而 R 默认是
**Mersenne-Twister**、播种法也不同 —— 接上去只会得到"看着像随机、每个数都不一样"。

所以这一刀不是"接上调用"，是**把发生器换成 R 那一条**：`ext/r/rt/omni_rng.c`
（**我们自己的代码**，照 `src/main/RNG.c` 公开的算法写）给出 MT19937 + R 的
`RNG_Init`（先把种子过 50 遍 `69069 * s + 1`，再用同一个 LCG 填满 625 格状态，
第 0 格摆 624）+ `fixup`（挡掉 0 与 1）+ `R_unif_index`（R ≥ 3.6 的拒绝采样）。
`ext/r/build.js` 里那份 `sunif.c` 因此**不编**了。

换掉之后 `runif` / `rnorm` / `rbinom` / `rpois` … 全是**R 自己的代码**（nmath 里那些
`r*.c`）跑在**R 自己的流**上；`norm_rand` 的算法由 `snorm.c` 的 `N01_kind` 决定，
默认是 `INVERSION`，与 R 一致。`sample()` 照 `do_sample` 的不放回算法（抽一格、
把末尾那格填进空位）。

没接的：`replace=` / `prob=`（Walker 别名法那一套）、`RNGkind()` 换发生器、
`rgamma` / `rweibull` 那几个"R 那侧先换算参数"的（要按 `stats/R/distn.R` 一条条核对；
`rexp` 那一格已经核过 —— R 传给 C 的是 `1/rate`）。

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
   `5` / `42L` / `1:n` 是 `int`，带小数点或指数的是 `real`。判据原来是输出
   （`cat(15)` 要印 `15` 而不是 `15.0`），而 `numFmtStmts()` 之后**那条理由已经不成立了**
   （`cat(15.0)` 照 R 的挑法也印 `15`）—— 现在留着 int 这一档是为了下标与循环量
   （`x[i]` 要 int、`1:n` 在 R 里本来也是整数向量），代价写在第四节第 8 条。
5. **下标从 1 起** —— 数值向量上 `x[i]` 落成 `(pload (padd x i))`（槽 0 是长度，所以偏移是
   `i-1+1`，字面量当场折掉）。`x[["k"]]` 是字典（R 的 `list` 带名字用就是关联表），
   `x[i]` 是向量 —— 靠第 4 条推出来的类型分。

一格 `hooks` 都没有：`dset` / `dget` 与向量上的 `pload` / `pstore` 由 adapter 直接发
（它知道类型），`cat` 落成一串 `write`（**不是 `print`**：方言的 `print` 自带换行，
R 的 `cat` 不带，差一个字节就对不上 `Rscript`）。

### 串那一族，与 R 的**两套有效数字**

同一个 double，R 有两个文本形式，而且挑法同源、只差位数：

- `cat(1/3)` / `print(1/3)` → `0.3333333`（7 位，`options(digits)`）
- `as.character(1/3)` / `paste(1/3)` / `sprintf("%s", 1/3)` → `0.333333333333333`
  （**15 位**，`coerce.c` 里写死的）

所以 `as.character(1e5)` 是 `1e+05` 而不是 `100000` —— 定点与科学记数那条挑法照旧管，
只是位数不同。落地就是 `asStr(…, dig)` 那一个参数（`r_num_str` 与 `r_sci` 都收位数）。

`toupper` / `substr` / `startsWith` / `endsWith` / `sprintf` 接了。`substr` 走生成出来的
那格函数：R 是**1 起、两端都含、越界截断**，而方言的 `(ssub S I N)` 是 0 起 + 长度、
越界当场报。`sprintf` 的**格式串在编译期就拆开**（真代码里它几乎总是字面量，而方言里没有
"运行期解析格式串"那一格）—— 认 `%[-][宽][.精度]{d,i,s,f,e,g}` 与 `%%`，位数那几格落
`(sfix …)` / `(ssci …)` / `(sgen …)`，也就是 C 的 `%.Nf` / `%.Ne` / `%.Ng`；格式串不是
字面量、或者出现没接的转换，**当场报**。判据是 `ext/r/examples/str.R`。

**`tolower` 没接**：方言里只有 `(supper …)`，没有反过来的那一格 —— 补它要给核心方言加一格
算子（五条腿都要动），那不属于 R 这一刀。`strsplit` / `gsub` / `grepl` 同理（要正则那一层）。

### `print` 与顶层的自动印

`cat` 与 `print` 在 R 里是两件事：`cat` 把值连成文本，`print` 印的是"这个对象长什么样"
—— 行首 `[k]` 标号、**一整条向量共用一套宽度**、到 80 列换行、串带引号。
共用宽度是 `formatReal` 的口径：每格的 `left` / `nsig` 先取极值，**挑一次**定点还是
科学记数，然后每格按同一套 `(w, d, e)` 右对齐。于是 `c(0.001, 1000)` 整条都走科学记数
（`1e-03 1e+03`），不会一格定点一格科学。账在 `printFnDecl`，判据是
`ext/r/examples/print.R`（1349 字节，逐字节对 `Rscript`；原生那条腿也单量过）。

**顶层的自动印**也接了（从前那一格是"什么都不印"——静默少一段输出）：R 在顶层对可见的值
自动调 `print`，所以 `x` 单独一行会印出来；赋值、`for` / `while`、`cat()`、`invisible()`
不可见。印的是这几种：字面量 / 名字 / 下标 / 一元二元算式 / `BUILTINS` 里的内建 /
**用户函数的调用**（回 void 的那些不印 —— 靠第四节第 5 条那张返回类型表分）。

内建认得的只有 `ext/r/adapter.js` 里 `BUILTINS` 那一张表 —— 那是判据不是方便：R 的内建在
树上与用户函数完全同形（`length(x)` 与 `f(x)` 一个形状），分开它们只能靠名字，
所以"接了哪些"要有一处说法，而不是散在一串 if 里。

### R 独有的那一格坑

**`length(s)` 不是串长。** 它是"这个向量有几个元素"，对一格串回 `1`。串长要 `nchar(s)`。
adapter 按类型分：串上 `slen`、表上 `dlen`、向量上读槽 0 —— `unary` 那一族第三行压的正是它。

## 四、明说的不足（**不猜**）

1. **向量化到"逐元素 + 回收 + 逻辑向量"这一层**，缺口是量出来的三处：
   * 回收时长的不是短的整倍数，R 会**警告**，我们不发 —— 那要一条输出通道，这一版没有；
   * `if (c(TRUE, FALSE))` 在 R 里是"取第一格 + 一句警告"，我们没有这一格；
   * nmath 那一族只在**第一格**实参上逐元素（`round(xs, c(1,2))` 那种多头回收当场报）。
2. **逻辑是三态的，标量那一格也立起来了**（`ext/r/adapter.js` 的 `RLGL1`，尺子是
   `ext/r/examples/lgl.R`）：`cat(NaN > 2)` 印 `NA`、`NA & FALSE` 是 `FALSE`、
   `zs[1]` 印 `TRUE`、`any` / `all` 回带 NA 的标量逻辑、`if (NA)` 走方言的 `(fail …)` 停下来。
   剩下两处口径差别：
   * **两边都是 int 的比较仍然回 `bool`**（`while (i <= n)` 那一格不绕）—— 这一档没有
     `NA_integer_`（见第 11 条），所以那个状态到不了；
   * `if (NA)` 停的方式不一样：R 印 `Error in …: missing value where TRUE/FALSE needed`
     并退出 1（`if (NaN)` 那一格 R 另有一句 `argument is not interpretable as logical`），
     我们两格都印 `omni: runtime error: missing value where TRUE/FALSE needed`
     并退出 70（方言里 `(fail …)` 的口径）。错误**文本**与退出码要对上，得先有 R 那套
     condition 系统（`tryCatch` / `warning`），这一版没有。
   * `&&` / `||` 在**有三态参与**时不短路（落成 `r_and` / `r_or` 那两个函数，两边都求值）。
     两边都是 `bool` 那一档照旧短路。为什么不短路：短路要临时量，而临时量在**条件位**上
     没地方摆 —— `while` 的条件被降级到循环外头，摊开的 `let` 会变成"只算一次"。
3. **不做懒求值**（promise / `missing()` / `substitute()`）—— 所以**形参默认值当场报**
   （`function(x, b = 2)`：R 里那个 `2` 是在函数体里才求值的一格 promise）。
4. **不做属性**（`names` / `dim` / `class`）、**不做 S3 / S4 / R5 分派**、
   **不做环境**（`<<-` 当普通赋值）、**不做 `...`**。
5. **用户函数的形参与返回类型是从调用点推出来的**（`inferFns()`，扫全程序、转三轮到
   不动点；判据是 `ext/r/examples/fn.R`）。所以 `half <- function(x) x / 2` 里 `x` 是
   real、`addone <- function(v) v + 1` 里 `v` 是向量、`isbig <- function(x) x > 2` 回的是
   三态逻辑。**还没做的两格**：
   * 同一个形参在不同调用点装**不同种**东西（一会儿数一会儿串）—— 那要运行期的类型标签
     （R 的 `SEXPTYPE`），这一档没有；两边对不上时留先来的那个（`widenTy` 只往
     `int → real → 向量` 这一条链上走）。
   * 形参默认值（`function(x, b = 2)`）—— 那是第 3 条那格 promise。
   顶层自动印也跟着这张表走：回 void 的函数（体尾是 `cat(…)` 那种）不印，别的印。
6. `print` 那一层只接**一格实参**（`digits=` / `quote=` 那几个命名实参没接），
   串里的引号与反斜杠**不转义**（R 印 `"a\"b"`，我们印 `"a"b"`），
   `list` 的 `print` 没接（那要 `$名字` 那一层）。
   base 那一族向量函数的命名实参也只认要紧的那几个（`head`/`tail` 的 `n=`、`rep` 的
   `times=`、`seq` 的 `by=`）—— `na.rm=` / `decreasing=` / `each=` / `length.out=` /
   `seq(n)` 那几种写法**当场报**，不猜。
7. 语法层两处：带 `-` 的原始串（`r"---(…)---"`，两侧个数要相同，这套词法项表达不了）、
   非 ASCII 字母的名字（`alpha` 只有 ASCII）。
8. `c()` 不带实参（空向量）没接 —— 这一层的长度至少是 1，"零长向量"要另一格表示
   （R 里 `c()` 是 `NULL`，而 `NULL` 在我们这儿还没有值）。
9. **数的印法**：R 的那条挑法**照 `src/main/format.c` 抄了**（`scientific()` +
   `formatReal()`，账在 `ext/r/adapter.js` 的 `numFmtStmts()`）—— 定点与科学记数按**哪个短**
   挑、7 位有效数字里尾随零不算、舍到有效数字时**就近取偶**，于是 `cat(1e5)` 印 `1e+05`、
   `cat(1.23456e5)` 印 `123456`、`cat(1000000.5)` 印 `1e+06`。量法是 `ext/r/examples/numfmt.R`
   逐字节对 `Rscript`（132 个值另外单量过一趟，含 `.Machine$double.xmin` 与 `5e-324`，
   两条腿都对上）。
   **剩下的那格差别是第 4 条的后果**：R 的数只有 double，而这一档把整数写法的字面量当
   `int`（`cat(15)` 要印 `15`）—— 于是 `cat(100000)` 我们印 `100000`（当 `100000L` 了），
   R 印 `1e+05`。写成 `1e5` / `100000.0` 就走上面那条路。
   那份 C 在 macOS 上用 **long double** 缩放，这儿只有 double：|kp| ≤ 22 上缩放因子是精确的
   （R 自己再往外也退回 `pow()`），量过的 132 格没有一处分叉。
10. 随机数那一族（`r*` / `set.seed` / `sample`）**接了**，数与 R 逐位相同（发生器换成了
    R 那一条，见第二节）。没接的是 `replace=` / `prob=`、`RNGkind()`、以及 `rgamma` /
    `rweibull` 那几个要先换算参数的。
11. `NA_integer_` / `NA_character_` 没接（实数的 `NA` 已经立住了）—— 见第二节那一小节。

## 五、另一档：libR（ADR-0046）

上面四节说的是**编译器那一档**：R 的源码 → 我们的 IR → JS / 原生。它快（`bench/r/run.js`
上标量循环比 Rscript 快 40 倍），但它只认我们接过的那些形状。

要跑 **CRAN 的包**（ggplot2、Rcpp…）就是另一件事了：那一层是 13.5 万行 R + 10 万行 C/C++，
而那些 C/C++ 引用了 **388 个 R 内部 C API 符号**（`Rf_eval` / `Rf_allocVector` / …）。
所以那一档走的是**真的 libR**，由我们自己从 r-source 的 C 编出来：

```
node ext/r/build-libR.js      # 405 条边：libR.dylib + R.bin + 12 个基础包 + Meta + 验一趟
node ext/r/install-cran.js    # 从 CRAN 下 tarball、按拓扑序装（默认那一串是 ggplot2 的闭包）
node ext/r/install-cran.js Rcpp
node tests/r/libr.js          # 这一档的尺子：六格都真跑
```

`R_HOME` 在 `.omni-cache/r-rt/libR/home`，`bin/R` / `bin/exec/R` 都在那儿。
两档的判据分开：编译器那一档是 `tests/r/oracle.js`（逐字节对 `Rscript`），
libR 那一档是 `tests/r/libr.js`（base / stats+LAPACK / methods 的 S4 / quartz 出 PNG /
ggplot2 的 `ggsave` / Rcpp 的 `cppFunction`）。

**这一档明写的两条口径**（都在 ADR-0046 里有账）：

* **R 自己那个用 R 写的字节码编译器不要**（`compiler` 包装着但永不开，`R_ENABLE_JIT=0`），
  base 那几个包按**源码**装。代价量过：R 级代码比本机那个 R 慢 **2~10 倍**
  （`bench/r/run.js` 第二列）。理由是快的那一侧在我们自己的编译器上 —— 同一张表里
  原生腿比 Rscript 快 17~76 倍。
* **窗口走 R 自己那份 Cocoa 设备**（`devQuartz.c` + `qdCocoa.m`），不走浏览器：
  `quartz()` 开的是真 `NSWindow`。例子在 `ext/r/libr-demo/ggplot.R`
  （`OMNI_R_WINDOW=1` 才开窗 —— 没有窗口服务的场合开它会报错）。

本机装的那个 R 在这一档里也只是**尺子**（`bench/r/run.js` 的参考列），运行时一格不借。
