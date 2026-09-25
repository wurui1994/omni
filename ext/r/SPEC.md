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

进出都是向量的几格：`rev` / `seq_along` / `which` / `sort` / `cumsum` / `cumprod` / `diff` /
`range` / `head` / `tail` / `rep` / `seq`；出一格数的几格：`sum` / `mean` / `max` / `min` /
`prod` / `var` / `sd`。`which` 回的是**位置**（数值向量），`NA` 直接丢 —— 与 `xs[m]` 不同
（那边 `NA` 挑出一格 `NA`），这两条口径是 R 自己分开的。

### 集合与位置那一族（判据 `ext/r/examples/setfn.R`）

`match` / `%in%` / `unique` / `duplicated` / `union` / `intersect` / `setdiff` / `order` /
`which.max` / `which.min` / `pmax` / `pmin`。难的只有两问，都是 R 自己的规矩：

* **"两格值算不算同一格"**（`r_same`）：`NA` 与 `NA` 算同一格（`NA %in% c(1, NA)` 是 TRUE、
  `unique(c(NA, NA))` 只剩一格）、`NaN` 与 `NaN` 也算、而 `NA` 与 `NaN` **不算**。
  按 `==` 比这三问全是假（浮点的规矩），所以单独落成一个函数，不摊在调用点上。
* **`order` 的次序**：缺失摆最后、同值按原来的先后（稳定）。这儿的比较把"原下标"当最后
  一把钥匙 —— 于是那个次序**唯一**，用哪种排序算法都得到 R 那一条（不必真写一个稳定排序，
  排的也是下标而不是值）。

`%in%` 的左边是一格数时回**三态标量**（那一格能直接进 `if (x %in% t)`），左边是向量时
逐元素出逻辑向量。`pmax` / `pmin` 是**两头回收**的（有一边零长就出零长）。
`which.max` / `which.min` 在"一格非缺失都没有"时 R 回 `integer(0)`，这一档没有那种值 ——
当场停下来（`(fail …)`）。字符向量上这一族都还没接（见第四节第 12 条）。


**缺失那一格每个函数的口径都不一样**，照 R 的文档办（判据是 `ext/r/examples/vecfn.R`）：
`sort` 把 `NA` **丢掉**（`na.last = NA` 是默认）、`max` / `min` / `range` **传下去**
（`max(c(1, NA))` 是 `NA` —— 按 `>` 比是躲不过去的：`NaN > x` 恒假会把 NA 悄悄跳过，
所以那一格每元素先问一句 `is.na`）、`cumsum` / `prod` / `var` / `sd` 按浮点自然传播。
`max` / `min` 里 **`NA` 与 `NaN` 还要分开记**：R 的口径是"有 `NA` 就是 `NA`、只有 `NaN`
才是 `NaN`"，而且**与次序无关**（`max(c(1, NaN))` 是 `NaN`、`max(c(NaN, NA))` 是 `NA`
—— 量出来的）。从前这儿见着缺失就当场回 `NA`，于是 `max(1, NaN)` 答 `NA` 而 R 答 `NaN`。

`na.rm = TRUE` 那一格**先滤再算**（`r_drop_na` 抄出一条没有缺失的）：这与"每个函数里各自
跳过"同解，而且 `mean` 的分母跟着变小、一处写法九个函数都对。只认字面量 `TRUE` / `FALSE`。

**`max` / `min` / `sum` / `prod` / `range` 收任意多格实参**（`max(1, 5, 3)` /
`sum(xs, 10)`）：办法是先把那几格**摊平成一条向量**（`numCatOf`，与 `c(…)` 同一段代码），
再走单实参那一格 —— 于是上面那几条缺失的规矩只有一份实现，不必在"两两折"里再写一遍。
**`mean` 不在这一档**：R 的 `mean(1, 2)` 答的是 `1`（第二格是 `trim=`），所以它多给一格
就当场报，不假装。`sort(x, decreasing = TRUE)` 是"升着排完倒过来"（相等的那几格在 double
上分不出来，所以与 R 逐字节一致）。

### 字符向量：**另一种存法**（`(arr string)`）

`c("a", "bb")` 不走上面那条 `(ptr real)` —— 它是方言的 `(arr string)`（0 起、长度问
`alen`、`apush` 能现长）。判据是 `ext/r/examples/strvec.R`，账在 `adapter.js` 的 `RSTRV`。

为什么分成两种存法：`(ptr real)` 那条路是**为了 `NA` 的 NaN 载荷**才走的（见上一小节），
串这一侧没有这个问题；反过来"把串编码成 double"要一张字符串表，这一版没有。代价是
`length` / `c` / `cat` / `print` / `for … in` 都要各写一档（各自一段，不是一段带分支）。

接了的：`c(…)`（摊平，含"有一格是串就整条收成字符向量"，数按 `as.character` 的 15 位转）、
`character(n)`、`v[i]` 读与写、`v[c(1,3)]` / `v[掩码]`、`length`、`cat`、`print`、
`for (s in v)`、`seq_along`、`rev`、`rep`（`times` / `each`）、
`nchar` / `toupper` / `tolower` / `substr` / `substring` / `trimws` /
`startsWith` / `endsWith` / `paste` **逐元素**（每一格转给标量那一版；后两个出的是
**逻辑**向量。`startsWith(v, c("a","b"))` 那种两边都回收的没接 —— 当场报）
（回收规则与数值那一侧同一条；零长那一格在 `paste` 里收成空串，这是 R 的规矩）、
找与换那一族（`grepl` / `grep` / `sub` / `gsub`，见那一小节）、
`ifelse(test, "y", "n")`（两支是串时出一条字符向量；`test` 里有 `NA` 时**当场停下来** ——
R 那儿挑出的是 `NA_character_`，这一档没有那种值，与 `v[掩码]` 同一条）。

`print` 与数值那一侧差三处，都是 R 自己的规矩：元素**带引号**、宽度按"最长那格 + 两个
引号"取、而且**左对齐**（数值右对齐）—— 所以 R 印出来的**行尾真的有空格**，逐字节对
`Rscript` 时这一格躲不过去。零长印 `character(0)`。

没接的几格明写在第四节第 12 条（`sort` 要 R 的 locale collation、越界与接长要串的缺失、
`tolower` 只管 ASCII）—— 都**当场报**，不给一个看着像对的答案。
`sort` 用的是 Shell 排序（Knuth 的 gap 序列）；R 自己用快排/基数排序，但**全排序的结果
是唯一的**（double 上相等的元素分不出来），所以两边逐字节一致。

**下标那一族三条规矩**（判据 `ext/r/examples/vec.R` 与 `strvec.R`，量出来的）：全是正数按位置挑、
而**下标 0 直接跳过**（`x[c(1,0,2)]` 出两格）、全是负数就把那几格**丢掉**（`x[-1]` /
`x[-c(1,3)]`，越界的负下标**不算** —— `x[-5]` 在长度 4 上就是原样）、正负**混着**当场停下来
（R 那儿也报错）。判正负是**运行期**的事（`x[c(-1,-2)]` 与 `x[-c(1,3)]` 在树上不同形），
所以这三条都在 `r_vec_pick` / `r_pick_str` 这**一处**，不在调用点上。
一格标量的负下标（`x[-1]` / `x[-i]`）要在**类型**上分得开（出来是向量不是一格数），那一格只能
看树 —— 变量里装着负数的那种（`k <- -1; x[k]`）照旧按位置取，越界时方言当场报。
下标里有 `NA` 时 R 挑出一格 `NA`，这儿停下来（挑出来的长度说不清）。

`sort` / `head` / `tail` / `rep` 出来的**元素类型跟着进去的那条走**（逻辑向量排完还是逻辑、
字符向量重复完还是字符向量）。`rep` 的三格都接了（`times` / `each`，R 的次序是**先 each
再 times**）；`seq` 认 `seq(n)` / `seq(a, b)` / `seq(a, b, by)` / `seq(a, b, length.out = k)`
——`length.out` 那一档步长是 `(b-a)/(k-1)`、**最后一格写成 `b`**（R 的 `seq.c` 也是这个口径）。
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

**逻辑当数用**也接了（`TRUE + TRUE` 是 2、`TRUE * 3` 是 3、`n <- n + (k > 2)` 那种数一数的
写法）：方言里 bool 上没有算术，所以有一边是 bool 就先摊成 int（字面量当场折，别的落一格
三元，见 `asNumE`）。比较那几格同理 —— 方言的 bool 之间没有 `>`，而 R 的 `TRUE > FALSE`
是 `TRUE`。赋值那一侧也要（`x <- TRUE` 之后 `x + 1`：那格名字被推成 int）。

线性内存这条路顺带把**两条腿**都走通了：`omni run`（JS + N-API）与 `omni build`（C 后端，
`ccall` 直接连 `libomniRmath`）对 `vec.R` 的输出都与 `Rscript` 逐字节相同。

**`NA_integer_` / `NA_character_` 还没接** —— 它们在 R 那边是另外两种表示
（`INT_MIN` 与一格特殊的 CHARSXP），要"带缺失的整数/串"那一层。

### 带名字的向量：名字**跟着变量**，不跟着值（判据 `ext/r/examples/named.R`）

`c(a = 1, b = 2)` 在 R 里是一条向量加一个 `names` **属性**（挂在 SEXP 上）。这一层的向量
就是一块 `(ptr real)`，没地方挂属性 —— 要跟着值走就得给每条向量套一个头（结构体 +
`fld` / `fldset`，而且**每一处**向量算子都要改）。所以这一档做的是另一半：名字另放一条
`(arr string)`，**跟着那个变量**走 —— `v` 的名字摆在 `v__nm` 里（账在 `adapter.js`
的 `RNVEC`）。真代码里名字几乎总是挂在一个有名字的量上（`counts <- c(a = 1, b = 2)`），
所以这一半覆盖得住常用写法。

接了的：`c(名字 = 值, …)`、`setNames(v, ns)`、`unname(v)`、`names(v)` 读、
`names(v) <- ns` 写、`v["a"]` / `v[["a"]]` 按名字取、逐元素算术把名字带过去
（`v * 2` / `v / 2` / `v + w`）、两行版式的 `print`。

印法照 R：名字一行、值一行，两行**共用一个宽** `max(值那一条的宽, 最长的名字)`，
每格右对齐到那个宽、后面跟一个空格 —— 所以**每行末尾有一个空格**（量出来的）。
一行几格是 `floor(80 / (宽 + 1))`，这一档没有 `[1]` 那个标号。零长印
`named numeric(0)`（元素是整数那一条印 `named integer(0)`，见第四节第 9 条）；名字那一条
空着（长度对不上）就退回 `r_print_num`，印的就是
`[1] …` —— R 里名字被丢掉之后也是这样。`v["不存在的名字"]` 回 `NA`、名字印 `<NA>`，
这也是 R 自己的答案（量出来的，不是我们编的）。

**跟不住的地方一律当场报。** 量出来的（`Rscript`，2026-09-25）：R 里
`sort` / `rev` / `head` / `tail` / `cumsum` / `abs` / `sqrt` / `round` / `is.na` /
`which.max` / `duplicated` / `c(v, 4)` / `v[v > 1]` / `v[c(1,3)]` **都把名字带过去**，
而 `range` / `unique` / `seq_along` / `as.character` / `paste` / 汇总那一族
（`sum` / `mean` / `max` / `min` / `length` / `var` / `sd`）**自己就丢名字**。
后一批照常算（`NAME_DROP_OK` 那张表），前一批**报** —— 静默丢掉的话 `print` 会少印
名字那一行，而例子的判据是逐字节对 `Rscript`，那种错最难查。真要丢就自己写 `unname(v)`。

还没接的两格，也都是报而不是猜：**带名字的逻辑向量**（`print(v > 1)`，R 会带名字）、
**函数交一格带名字的向量**（名字跟着变量走，出不了函数 —— 要带就在调用点上
`setNames(f(…), ns)` 装回去）。

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
   `list(n = 10, tol = 0.5)` **造的时候就带内容**那一档也接了（判据 `ext/r/examples/list.R`）：
   落成一格 `block-expr`（`dnew` 之后一格一格 `dset`）。值类型是**整张表一起推**的 ——
   有一格是 double 整张表就装 double，于是后面 `m[["k"]] <- 3` 那个 3 自动加宽
   （不加宽方言那侧报"dset 的值要是 real，这里是 int"，量出来的）。
   `list(1, 2)`（**位置**实参）当场报：R 那儿它是按位置存的，而这一层的表只有"按名字取"。
   **`m$k` 与 `m[["k"]]` 是同一件事**（R 里 `$` 就是按名字取）：读、写（`m$k <- v`）、
   问有没有（`is.null(m$k)`）三格都接了，落的都是 `dget` / `dset` / `dhas`。
   R 的 `$` 还会**部分匹配**（`cfg$to` 取到 `tol`）—— 这儿不做，写全名；
   `$` 的左边不是表（data.frame 的列 / S4 的槽 / 环境）当场报。
   **`v[["a"]]` 不一定是表**：`v <- c(a = 1, b = 2)` 之后它是"带名字的向量上按名字取"
   （见第二节那一小节）。这一格只能按形状分 —— 被 `c(…)` / `setNames(…)` / `numeric(…)`
   赋过的名字是向量，被 `list(…)` 赋过的是表。

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

`toupper` / `tolower` / `substr` / `substring` / `trimws` / `startsWith` / `endsWith` /
`sprintf` 接了，还有"这是什么东西"那三问（`is.character` / `is.numeric` / `is.logical` ——
类型在这一层是推出来的，所以它们是**编译期常量**）。`substr` 走生成出来的
那格函数：R 是**1 起、两端都含、越界截断**，而方言的 `(ssub S I N)` 是 0 起 + 长度、
越界当场报。`sprintf` 的**格式串在编译期就拆开**（真代码里它几乎总是字面量，而方言里没有
"运行期解析格式串"那一格）—— 认 `%[-+0 ][宽][.精度]{d,i,s,f,e,E,g,G,x,X,o}` 与 `%%`：
位数那几格落 `(sfix …)` / `(ssci …)` / `(sgen …)`（C 的 `%.Nf` / `%.Ne` / `%.Ng`），
进制那几格落 `(sbase …)`，`0` 旗子补零时**符号留在最前**（`%05.1f` 的 -1.5 是 `-01.5`），
`+` 与空格只在**非负**时补（负数自己带 `-`）。格式串不是
字面量、或者出现没接的转换，**当场报**。判据是 `ext/r/examples/str.R`。

**`tolower` 只管 ASCII**：方言里只有 `(supper …)`，没有反过来的那一格 —— 补它要给核心方言
加一格算子（五条腿都要动），那不属于 R 这一刀。所以 `r_lower` 用现成的算子办：拿两张 26 个
字母的表查一遍（`(sfind 大写表 这个字符)` 给位置，再从小写表里取同一格），表里查不到的
字符原样留下。R 那边非 ASCII 是跟 locale 走的，那一层没有。
`strsplit(s, sep)` 接了**两种形状**：`strsplit(s, sep)[[1]]` 与 `unlist(strsplit(s, sep))`
（R 那边它回的是一张**表**，每格一条字符向量，而这一层没有"表里装向量"—— 裸着写当场报）。
`split=` 在 R 里默认是**正则**，所以只收"没有正则元字符的串字面量"，或者明写
`fixed = TRUE`（那时任意字面量都行）；不是字面量的当场报 —— 那时没法知道它是不是正则。
三条口径是量出来的：空串进 → 零长、`sep` 是空串 → 一格一个字符、**末尾那格空串不要**
（`strsplit("a,b,", ",")` 是 `"a" "b"`）。

### 找与换：**只认按字面找**那一档（判据 `ext/r/examples/find.R`）

`grepl` / `grep` / `sub` / `gsub` 接了，规矩与 `strsplit` 同一条：pattern 只收**串字面量**、
而且里头**没有正则元字符**（`. \ | ( ) [ ] { } ^ $ * + ?`），或者明写 `fixed = TRUE`。
R 这一族默认按 POSIX 扩展正则匹配，而正则那一层这儿没有 —— 不是字面量时连"它是不是一条
正则"都不知道，那时按定串找就是**静默答错**。真代码里这一族的实参多半就是定串
（`gsub(",", "", s)`），所以这一半覆盖得住。

形状：`grepl` 跟着被找的那一格（一格串 → 一格真假、字符向量 → 逻辑向量）、`grep` 回
**位置**（`value = TRUE` 回那几格元素）、`sub` 换第一处 / `gsub` 全换（字符向量上逐元素）。
换是**不重叠、从左往右**（`gsub("aa", "b", "aaaa")` 是 `"bb"`，量出来的）。
一格串上的 `grepl` 直接落成 `(sfind s p) >= 0`，不必发函数；从某一处往后找是"把剩下那段
`ssub` 出来再 `sfind`" —— 方言的 `sfind` 只从头找。

当场报的几格：正则、`ignore.case=`、`\\1` 那种回引用、空串 pattern（R 那一档是"每个字符
之间都算一次"）、一格串上的 `grep`（写 `grepl`）、`regexpr`（R 那一格回的值上挂着
`match.length` 等属性，印出来是四段，而属性那一层只做了 `names` 的一半）。

`stop(…)` / `stopifnot(…)` 落方言的 `(fail …)`：R 印 `Error: …` 并退出 **1**，我们印
`omni: runtime error: …` 并退出 **70** —— 消息正文一样，壳不一样（与 `if (NA)` 同一条，
见第四节第 2 条）。`stopifnot` 的那句话 R 里是把表达式本身反解出来（`x > 0 is not TRUE`），
这一层没有 deparse，所以给的是一句固定的。`warning` / `message` / `tryCatch` 没接
（要 R 那套 condition 系统）。

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

**表外的名字当场报，而且报 R 的那个名字**（`gapHint`）：从前它是"照原样发、让链接期去说"，
于是 `data.frame(…)` 报出来的是 `未声明的函数 'data_frame'` —— mangle 之后的名字，源码里
根本没有这个词，读的人会以为是链接坏了。现在分三档指路：包那一层（`library`）→ **libR 那一档**
（第五节）、表格那一层（`data.frame` / `dim` / `matrix`）→ 第四节第 4 条、剩下的 → 这张表。
（`names` / `setNames` / `unname` **已经在这张表里了** —— 见第二节"带名字的向量"那一小节。）

### 函数当实参：**把那段匿名函数摊开**（判据 `ext/r/examples/apply.R`）

`sapply` / `vapply` / `lapply` / `Reduce` / `Filter` 接了，办法是**摊开**而不是造函数值：
真代码里这几格的实参几乎总是就地写的 `function(…) …`，那时把形参绑到元素上、把函数体当一段
表达式摊进循环里就够了 —— 没有闭包、没有函数值。出来是哪一种向量看**函数体**（出数是数值
向量、出真假是逻辑向量、出串是字符向量）。

给一个函数**名字**（`sapply(v, sqrt)`）当场报：那要真的函数值（连着环境一起搬），不在这一刀里。
另两处也当场报：`lapply` 裸着用（R 回一张表，这一层没有"表里装向量"—— 写 `unlist(lapply(…))`）、
`sapply` / `vapply` 在**字符向量**上（R 会拿那些串当结果的**名字**，`USE.NAMES = TRUE`，
而这一层没有 `names`；`unlist(lapply(…))` 那一格没有名字，两边同解）。
`Map` / `do.call` / `Recall` 没接。

### `switch(…)`：R 的分支那一格（判据 `ext/r/examples/branch.R`）

R 的 `switch` 按**选择子的类型**分两套规矩（`do_switch`），两套都接了：

* 选择子是**串** —— 分支按名字配；`a = , b = 2` 那种**空分支往下落**
  （`switch("a", a = , b = 2)` 是 2）；最后一格**没名字**的是兜底。
* 选择子是**数** —— 分支按位置配（1 起），分支不该带名字。

落成一条 if 链。摆在**语句位**上每一支是语句（`cat(…)` 只能摆在那儿），摆在**表达式位**上
每一支是值（落方言的 `if-expr` —— 那一格每支自己一个语句槽，所以是懒的，与 R 只求被选中
那一支一致）。尾位上算语句还是值，看**每一支在干什么**（`switchIsStmt`）：每一支都是
`cat` / `print` / 赋值那种"做事不交值"的就按语句落 —— 不靠"先试一次报错了再换一条路"，
那种写法会把真错吞掉。

**没配上时 R 回"不可见的 `NULL`"**，而这一层没有 `NULL`：语句位上那正好是"什么都不做"
（一格 else 都不发）；**表达式位**上要一格兜底，没有就当场报（回 0 是静默答错）。
**数**那一档在表达式位上一律当场报 —— 位置那一档没有"兜底"的写法，而越界回的是 `NULL`。
顶层裸着写一格 `switch` 按**语句**算（`NO_AUTOPRINT`）：R 那儿它交的值是可见的会印出来，
这一层不印 —— 真要那个值就 `x <- switch(…)` 再 `print(x)`。

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
3. **不做懒求值**（promise / `missing()` / `substitute()`）。**形参默认值与命名实参接了**   （`pow <- function(x, k = 2)`、`pow(k = 3, x = 2)`），办法是**在调用点把缺的那几格
   填上默认值那棵树** —— 方言里函数的元数是定死的，没有"少传几个实参"这一档。
   由此来的两处与 R 不同：
   * 默认值**不许引用这个函数自己的形参**（`function(x, y = x)` 当场报）—— 那要真的
     promise：调用点上还没有 `x` 这个名字；
   * 默认值是在**调用点**求值的（R 在被调方求）。常量那一档（`n = 10` / `sep = ", "` /
     `tol = 1e-8`，真代码里几乎全是这一档）两者同结果；默认值引用**全局量**的那种，
     求值时机两边不同（我们早、R 晚）。
   实参少给了 R 是"用到才报 argument is missing"，这一档在**编译期**就报。
4. **属性只做了 `names` 的一半**（`dim` / `class` 一格没有）、**不做 S3 / S4 / R5 分派**、
   **不做环境**、**不做 `...`**。
   `names` 那一半是"**名字跟着变量走**"（`v__nm`，第二节那一小节有账与判据
   `ext/r/examples/named.R`）：`c(a = 1, …)` / `setNames` / `unname` / `names(v)` 读写 /
   `v["a"]` / 逐元素算术 / 两行版式的 `print` 都接了，**R 会把名字带过去而我们带不了的那些
   （`sort` / `rev` / `head` / `cumsum` / `abs` / `c(v, 4)` / `v[v > 1]` / 交出函数）一律
   当场报** —— 不静默少印名字那一行。
   `names(一张 list)` 与 `print(一张 list)` **还是不行**，而且这一格卡在方言上：
   字典的算子只有 `dnew` / `dget` / `dset` / `dhas` / `dlen`，**没有"把键列出来"那一条**。
   要接它得先给核心方言加一格算子，那是另一件事。
   **顶层的名字函数看得见**（尺子是 `ext/r/examples/glob.R`）：函数体里**自由**用到的那些
   顶层名字落成方言的 `(global 名字 类型)`，`main` 开头只给向量与表摆一块地方（标量本来
   就是零起步）。"自由"是算出来的 —— 形参、`<-` 赋过的名字、`for` 的循环量都算这个函数
   自己绑的，所以 `sieve` 里的 `i` 跟顶层同名的 `i` 没关系（`freeSyms()`）。
   由此来的两处与 R 不同：
   * `<<-` 就是**写那格模块级变量**，不爬词法链（真 R 从当前环境的父环境往上找第一格
     有这个名字的）。单层嵌套（顶层函数写顶层变量，真代码里几乎全是这一档）两者同解。
   * 函数里 `xs[i] <- v`，若 `xs` 是顶层那格，我们**写的是那格本身**；真 R 先复制一份
     再改，改的是局部的那个副本（要写外面得 `xs[i] <<- v`）。记忆化那种用法（
     `ext/r/examples/glob.R` 的 `memo`）两者答案相同、只差快慢；靠"改不到外面"来写的
     代码两边会不一样。
5. **用户函数的形参与返回类型是从调用点推出来的**（`inferFns()`，扫全程序、转三轮到
   不动点；判据是 `ext/r/examples/fn.R`）。所以 `half <- function(x) x / 2` 里 `x` 是
   real、`addone <- function(v) v + 1` 里 `v` 是向量、`isbig <- function(x) x > 2` 回的是
   三态逻辑。形参也跟着**函数体里的赋值**变宽（`collatz_len(n)` 从调用点是 int，体里
   `n <- n / 2` 把它推成 real），变宽的结果再喂回调用点那一侧。**还没做的一格**：
   * 同一个形参在不同调用点装**不同种**东西（一会儿数一会儿串）—— 那要运行期的类型标签
     （R 的 `SEXPTYPE`），这一档没有；两边对不上时留先来的那个（`widenTy` 只往
     `int → real → 向量` 这一条链上走）。
   顶层自动印也跟着这张表走：回 void 的函数（体尾是 `cat(…)` 那种）不印，别的印。
6. `print` 那一层只接**一格实参**（`digits=` / `quote=` 那几个命名实参没接），
   串里的引号与反斜杠**不转义**（R 印 `"a\"b"`，我们印 `"a"b"`），
   `list` 的 `print` 没接：R 印一张 list 要一行一行 `$名字` 地印，而这一层的表**问不出
   它有哪些键**（方言的字典只有 `dnew` / `dget` / `dset` / `dhas` / `dlen`，没有"列出键"
   那一格）。`names(m)` 同理 —— 要补就得先给核心方言加一格算子，那不属于 R 这一刀。
   （**向量**上的 `names` 接了，那一条不靠字典，见第二节。）
   **命名实参过一张白名单**（`adapter.js` 的 `NAMED_OK`）：认得的是 `cat` 的 `sep=`、
   `paste` 的 `sep=` / `collapse=`、聚合那一族的 `na.rm=`（`sum` / `prod` / `mean` /
   `max` / `min` / `range` / `var` / `sd` / `any` / `all`）、`head`/`tail` 的 `n=`、
   `rep` 的 `times=` / `each=`、`seq` 的 `by=` / `length.out=`、`numeric(n)` 那一族的
   `length=`、`sort` 的 `decreasing=`、找与换那一族的 `fixed=` / `value=`。
   **表外的一律当场报** —— `length.out=`（`rep` 上那一格）/ `na.last=` / `ignore.case=` /
   `digits=` / `quote=` 都在表外。这张表是为了躲一种静默答错：从前认不出来的命名实参
   被**直接丢掉**，于是 `sum(x, na.rm = TRUE)` 答 `NA` 而 R 答 4（量出来的）。
   `na.rm = TRUE` 的落法是**先滤一遍再算**（`r_drop_na`），与"每个函数里各自跳过"同解；
   只认字面量 `TRUE` / `FALSE`（运行期的旗子要两条路都发，那是另一件事）。
   `sort` 上**没有** `na.rm=`（R 自己都报"参数没有用"）—— 它默认就丢掉缺失。
   **`list` / `switch` / `c` 这三格不过这张白名单**：它们的命名实参是**数据**（键名 / 分支名 /
   元素名），不是开关 —— `list(n = 10)` 的 `n` 是键、`c(a = 1)` 的 `a` 是元素名。
7. 语法层两处：带 `-` 的原始串（`r"---(…)---"`，两侧个数要相同，这套词法项表达不了）、
   非 ASCII 字母的名字（`alpha` 只有 ASCII）。
8. `c()` 不带实参在 R 里是 `NULL`，这一档落成**零长向量** —— 最常用的那个写法上同解
   （`out <- c(); out <- c(out, i)` 那种攒结果的循环）。差别是 `is.null(c())`：R 回 TRUE，
   我们这儿它是一条零长向量。`numeric(n)` / `logical(n)` / `integer(n)` 接了（一条零向量）。
   **真正的 `NULL`** —— 当值传、当 list 的一格、`is.null(x)` 对任意 x —— 没有。
9. **数的印法**：R 的那条挑法**照 `src/main/format.c` 抄了**（`scientific()` +
   `formatReal()`，账在 `ext/r/adapter.js` 的 `numFmtStmts()`）—— 定点与科学记数按**哪个短**
   挑、7 位有效数字里尾随零不算、舍到有效数字时**就近取偶**，于是 `cat(1e5)` 印 `1e+05`、
   `cat(1.23456e5)` 印 `123456`、`cat(1000000.5)` 印 `1e+06`。量法是 `ext/r/examples/numfmt.R`
   逐字节对 `Rscript`（132 个值另外单量过一趟，含 `.Machine$double.xmin` 与 `5e-324`，
   两条腿都对上）。
   **剩下的那格差别是第 4 条的后果**：R 的数只有 double，而这一档把整数写法的字面量当
   `int`（`cat(15)` 要印 `15`）—— 于是 `cat(100000)` 我们印 `100000`（当 `100000L` 了），
   R 印 `1e+05`。写成 `1e5` / `100000.0` 就走上面那条路。
   **零长向量的类型名**从前也是这一格的后果 —— 现在**补上了**：向量上多带一个记号
   （`adapter.js` 的 `RIVEC`，`typeToSx` 看不见它），位置那一族（`which` / `seq_len` /
   `seq_along` / `order` / `match` / `nchar` / `integer(n)` / `1:n` / `sample`）算整数向量，
   `cumsum` / `diff` / `sort` / `rev` / `head` / 三格集合运算跟着进去的那条走。
   非零长那一档两者印得一样，所以这个记号只管零长那一行字（判据 `ext/r/examples/print.R`）。
   从前 `print(which(x > 100))` 印的是 `numeric(0)` 而 R 印 `integer(0)` —— 那是静默差一行字。
   那份 C 在 macOS 上用 **long double** 缩放，这儿只有 double：|kp| ≤ 22 上缩放因子是精确的
   （R 自己再往外也退回 `pow()`），量过的 132 格没有一处分叉。
10. 随机数那一族（`r*` / `set.seed` / `sample`）**接了**，数与 R 逐位相同（发生器换成了
    R 那一条，见第二节）。没接的是 `replace=` / `prob=`、`RNGkind()`、以及 `rgamma` /
    `rweibull` 那几个要先换算参数的。
11. `NA_integer_` / `NA_character_` 没接（实数的 `NA` 已经立住了）—— 见第二节那一小节。
    由此来的两格**当场报**（不猜）：`as.integer(x > 2)`（R 答 `NA_integer_`）与
    `as.character(一条向量)`（R 出的字符向量里 `NA` 印出来**不带引号**）。
    **`as.numeric` / `as.integer` 本身接了**（判据 `ext/r/examples/str.R`）：real / int /
    两态逻辑 / 三态逻辑标量 / 数值与逻辑**向量**都答得准 —— 向量本来就是 double，
    `as.integer` 逐元素**朝零截**而缺失原样留着（"整数向量"底下还是 double，`NA` 跟得住）。
    **把串转成数没接**，而且这一格卡在方言上：核心方言没有"串 → 数"那一格算子
    （`toint` / `toreal` 只在 int 与 real 之间转）。自己写一圈按位累加在 15 位有效数字
    或者 10^±22 之外与 `strtod` 的舍入对不上 —— 那是静默差最后几位，所以当场报。
12. **字符向量接了**（`(arr string)`，判据是 `ext/r/examples/strvec.R`，见第二节那一小节）：
    `c(…)` / `character(n)` / `v[i]` 读写 / `v[c(1,3)]` / `v[掩码]` / `length` / `cat` /
    `print` / `for (s in v)` / `seq_along` / `rev` / `nchar(v)` / `toupper(v)` /
    `tolower(v)` / `paste(…)` 逐元素（含回收与 `collapse=`）。**没接的是这几格**：
    * `sort(v)` —— R 排串按 **locale 的排序规则**（`Scollate`），不是按字节：
      `sort(c("pear","apple","Banana"))` 在 R 那边是 `"apple" "Banana" "pear"`，
      按字节比 `"Banana"` 会跑到最前面。要对上得先有那套 collation。同理 `head` /
      `tail` / `rep` / `which` / `order` / `match` / `%in%` / `unique` / `duplicated` /
      `union` / `intersect` / `setdiff` 在字符向量上也都当场报。
    * **数的是字节，不是字符。** 方言的 `slen` / `ssub` / `supper` 都按字节办，而 R 的
      `nchar` / `substr` / `toupper` 按**字符**（跟 locale 走）。量出来的（`Rscript`，
      2026-09-25）：`nchar("héllo")` R 答 5、按字节是 6；`substr("héllo", 1, 2)` R 出
      `"hé"`、按字节切出半个字符。要接它得先给核心方言加"按码位走"那一层
      （现在连"取第 i 个字节"都没有算子：只有 `slen` / `ssub` / `sfind`）。
      所以 `nchar` / `substr` / `substring` / `toupper` / `tolower` / `sprintf` 上
      **串字面量里有非 ASCII 就当场报**（`BYTEWISE` 那张表）—— 那是编译期看得出来的那一半，
      运行期才知道的拦不住，明写在这儿。`cat` / `paste` / `grepl` / `sub` / `gsub` /
      `startsWith` **按字节办也对**（拼接与定串查找与码位无关），不在那张表里。
    * `tolower` 只管 **ASCII**：方言里只有 `(supper …)`，没有反过来的那一格，所以
      `r_lower` 拿两张 26 个字母的表查（`(sfind 大写表 这个字符)` 给位置）。表里查不到的
      字符原样留下 —— R 那边非 ASCII 是跟 locale 走的。`toupper` 走方言的算子，口径随它。
    * 越界与接长：`v[10]` 在 R 里出 `NA_character_`、`v[n+1] <- s` 会把向量接长，
      这儿两格都是 `(aget …)` / `(aset …)` 越界**当场报**（我们没有串的缺失）。
      掩码里有 `NA` 时 R 挑出一格 `NA`，这儿停下来（`(fail …)`）。
    * 引号与反斜杠在 `print` 里**不转义**（与标量那一格同一条，见第 6 条）；
      `NA_character_` 没有（见第 11 条）—— 空串就是空串，不是缺失。
    连带的两格：`strsplit` 接了两种形状、`grepl` / `grep` / `sub` / `gsub` 接了
    **按字面找**那一档（都在第三节）—— 正则本身还是没有。

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
node tests/r/libr.js          # 这一档的尺子：八格都真跑
```

**base 装成源码那一格少掉的那一半要补回来。** R 正经的构建里 `library/base/R/base` 装的是
`baseloader.R`（懒加载那条路），我们装的是 `all.R`（`mkRbase` 那条），于是 `baseloader.R`
里**只在那儿**做的三件事全丢了 —— 最要紧的是用 `getDLLRegisteredRoutines("base")` 把
`.C_*` / `.F_*` 那批**原生符号对象**摆进 base 的命名空间。少了它 `addTaskCallback()` 一调
就报 `object '.C_R_addTaskCallback' not found`，而调它的正是 `cli` 的 `.onLoad`：
`library(ggplot2)` 会吐四行 `'ansi_show_cursor' is not an exported object from
'namespace:cli'`，**而图照样出得来**（量出来的，2026-09-25）。所以 `mkbase` 那条边在
`all.R` 后面**接上 `baseloader.R` 的尾巴**（从源码里截，不手抄），
判据是 `tests/r/libr.js` 第 2 格；而且那一轴每一格现在都判"输出里一行 Error 都没有" ——
只看退出码与"要的那一行在不在"是发现不了这种病的。

**跑一份脚本不用手敲那一串**：`omni run x.R` 一句管到底 —— 编译器那一档接得住就走它
（快 17~76 倍），接不住就**自己换到这一档**，并把"为什么换"印在 stderr 上（不闷着换）。
登记在 `langs.js` 的 `runFallback` 上、落在 `ext/r/libr-run.js`；`build` 上不换（那一档给不出产物）。
换过去的那趟把 **R 自己的编译器三格全关**：

```
R_ENABLE_JIT=0        跑的时候不即时编译（`compiler` 包那一层）
R_COMPILE_PKGS=0      装包的时候不字节编译
R_DISABLE_BYTECODE=1  连**执行**字节码那一路也关掉（`bcEval` 不进，走 AST 那条）
```

前两格是"不产生字节码"、第三格是"就算包里带着也不跑它"—— 三格一起摆才是真的不借。
量法在 `tests/r/libr.js` 最后一格：JIT 级别是 0、转过 100 圈的函数体还是 `call`
（不是 `bytecode`）、装进来的 `stats::var` 的体还是 `{`。

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
