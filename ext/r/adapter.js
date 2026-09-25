// ext/r/adapter.js —— **R 的树 → 标准 IR**（ADR-0044 §1.2）
//
// 语法那一半照 R 自己的 `gram.y` 复刻（见 `ext/r/r.grammar` 文件头）。这一半是**映射**：
// 那棵 CST 上的节点 → 标准 IR，语义降级交给 `src/core/lower/` 那一份公共降级器。
//
// ## R 这门语言要 adapter 自己消化的五件事
//
//   1. **函数是值**。`f <- function(n) …` 在树上是一格赋值，不是声明。所以顶层扫一遍：
//      右边是 `(fn …)` 的赋值提升成 `{kind:'fn'}`，别的落进 `main`。
//   2. **最后一句就是返回值**（没有 `return` 也要返）。`return(x)` 在 R 里是**一次调用**，
//      不是语句 —— 两条都在这儿摆平（`tailOf`）。尾位上的 `if` 要往两支里钻，
//      不能囫囵包成一格 `ternary`：`if (n == 0) return(1)` 那种只有一支带值。
//   3. **没有声明**。`acc <- 0` 既是赋值也是"第一次出现"（与 awk 同一格），所以扫一遍
//      被赋值的名字，在段顶上补一串 `let`。
//   4. **类型**。方言那一层不推导只检查，所以"这个名字装的是什么"必须在这儿答完。
//      R 的数其实只有 double，这儿按**字面量的写法**分：没有小数点没有指数的是 `int`
//      （`5`、`1:n`、`42L`），带小数点或指数的是 `real`。判据是那几份例子的输出
//      （`cat(15)` 要印 `15` 而不是 `15.0`），与 awk 那一格同一个取舍。
//   5. **下标从 1 起**。`x[i]` → `aget(x, i-1)`，字面量当场折掉。`x[["k"]]` 多半是字典
//      （R 的 `list` 带名字用就是关联表），`x[i]` 是数组 —— 靠上面第 4 条推出来的类型分。
//      `x` 被 `c(…)` / `setNames(…)` 赋过时 `x[["k"]]` 是**带名字的向量上按名字取**
//      （见 `RNVEC` 与 `dictNames`）。
//
// ## 明说的不足（**不猜**；正本在 `ext/r/SPEC.md` 第四节）
//
//   1. **向量化做到"逐元素 + 回收 + 逻辑向量"这一层**，缺的三处是量出来的：回收长度不整倍
//      时 R 的那句**警告**我们不发、`if (c(TRUE,FALSE))` 的"取第一格 + 警告"没有、
//      nmath 那一族只在第一格实参上逐元素。
//   2. **逻辑是三态的**（`NA` 真的走到底，见 `RLGL` / `RLGL1`）。两处口径差别：两边都是
//      int 的比较仍然回方言的 `bool`（这一档没有 `NA_integer_`，那个状态到不了），
//      而 `&&` / `||` 有三态参与时**不短路**（原因在 `FN_DEPS` 那段账上）。
//   3. **不做懒求值**（promise / `missing()` / `substitute()`）、**属性只做了 `names` 的
//      一半**（名字**跟着变量**走，见 `RNVEC`；`dim` / `class` 一格没有）、
//      **不做 S3 / S4 / R5 分派**、**不做环境**
//      （`<<-` 当普通赋值）、**不做 `...`**。形参默认值与命名实参**接了**（在调用点填，
//      见 `fnDefs`）；用户函数的形参与返回类型是**从调用点推**的（`inferFns`）：
//      同一个形参在不同调用点装不同**种**东西那一格没做（要运行期类型标签）。
//   4. 内建只认下面 `BUILTINS` 那一张表，表外的名字当用户函数调（调不到就是链接期的错）。

import { isList, tag, kids, leaf } from '../../src/core/lower/cst.js';
import { rmathLib, rmathSig } from './rt/ffi.js';

/* ─── R 的数值运行时：**R 自己的 C 代码** ────────────────────────────────────
 *
 * `round(0.5)` 在 R 里是 `0`（到偶），`round(2.675, 2)` 是 `2.67`（二进制里 2.675 比它看
 * 起来小一点）。这些不是"我们算错了"能修的东西 —— 它们**就是** `r-source/src/nmath/fround.c`
 * 那段代码的行为。所以这一族一律转发过去：`ext/r/build.js` 把 `src/nmath` 的 121 份 `.c`
 * 编成 `libomniRmath`，签名由 `rt/ffi.js` 从**同一次构建生成的** `Rmath.h` 读出来（不手抄）。
 *
 * 这张表只说三件事。R 的可选实参在 C 那侧是必填的（`dnorm(x)` → `dnorm4(x, 0, 1, 0)`：
 * 均值、标准差、要不要取对数），补的值照 R 的文档。
 *
 *   sym   —— `Rmath.h` 里的名字（**不一定与 R 的函数同名**：`dnorm` 在头里是 `dnorm4`）
 *   fill  —— 实参表；`null` 是"这一格由 R 那边的位置实参填"，别的是缺省值。长度 = C 的元数 */
const RMATH = new Map([
  /* 取整与精度（`fround.c` / `fprec.c` / `ftrunc.c` / `fsign.c`）—— 整件事的起点 */
  ['round', { sym: 'fround', fill: [null, 0] }],
  ['signif', { sym: 'fprec', fill: [null, 6] }],
  ['trunc', { sym: 'ftrunc', fill: [null] }],
  ['sign', { sym: 'sign', fill: [null] }],
  /* 两格取大小。R 的 `max`/`min` 收任意多格（那要向量），所以这儿只登记 `pmax`/`pmin`
     的两格形式 —— 名字不一样就不会与"以后做了向量"的那一版撞。 */
  ['pmax', { sym: 'fmax2', fill: [null, null] }],
  ['pmin', { sym: 'fmin2', fill: [null, null] }],
  /* Gamma 那一族（`gamma.c` / `lgamma.c` / `polygamma.c` / `beta.c` / `choose.c`） */
  ['gamma', { sym: 'gammafn', fill: [null] }],
  /* `factorial(x)` 在 R 里就**定义成** `gamma(x + 1)`（所以 `factorial(2.5)` 是
     `3.323351`，不是报错）。这张表里只这一格要给第一个实参加个常数 —— 一行 `bump`。 */
  ['factorial', { sym: 'gammafn', fill: [null], bump: 1 }],
  ['lgamma', { sym: 'lgammafn', fill: [null] }],
  ['digamma', { sym: 'digamma', fill: [null] }],
  ['trigamma', { sym: 'trigamma', fill: [null] }],
  ['beta', { sym: 'beta', fill: [null, null] }],
  ['lbeta', { sym: 'lbeta', fill: [null, null] }],
  ['choose', { sym: 'choose', fill: [null, null] }],
  ['lchoose', { sym: 'lchoose', fill: [null, null] }],
  ['log1p', { sym: 'log1p', fill: [null] }],
  ['expm1', { sym: 'expm1', fill: [null] }],
  /* 分布那一族。`lower.tail = TRUE` → 1、`log = FALSE` → 0，照 R 的默认值补。
     **随机数那一族（`r*`）在另一张表**（`RRAND`）：它们的第一个实参是"要几个"，
     出来的是一条向量，形状与这张表不同。 */
  ['dnorm', { sym: 'dnorm4', fill: [null, 0, 1, 0] }],
  ['pnorm', { sym: 'pnorm5', fill: [null, 0, 1, 1, 0] }],
  ['qnorm', { sym: 'qnorm5', fill: [null, 0, 1, 1, 0] }],
  ['dbinom', { sym: 'dbinom', fill: [null, null, null, 0] }],
  ['pbinom', { sym: 'pbinom', fill: [null, null, null, 1, 0] }],
  ['dpois', { sym: 'dpois', fill: [null, null, 0] }],
  ['ppois', { sym: 'ppois', fill: [null, null, 1, 0] }],
  ['dgamma', { sym: 'dgamma', fill: [null, null, 1, 0] }],
  ['pgamma', { sym: 'pgamma', fill: [null, null, 1, 1, 0] }],
  ['dbeta', { sym: 'dbeta', fill: [null, null, null, 0] }],
  ['pbeta', { sym: 'pbeta', fill: [null, null, null, 1, 0] }],
  ['dt', { sym: 'dt', fill: [null, null, 0] }],
  ['pt', { sym: 'pt', fill: [null, null, 1, 0] }],
  ['dchisq', { sym: 'dchisq', fill: [null, null, 0] }],
  ['pchisq', { sym: 'pchisq', fill: [null, null, 1, 0] }],
  ['besselI', { sym: 'bessel_i', fill: [null, null, 1], take: 2 }],
  ['besselJ', { sym: 'bessel_j', fill: [null, null] }],
  ['besselK', { sym: 'bessel_k', fill: [null, null, 1], take: 2 }],
  ['besselY', { sym: 'bessel_y', fill: [null, null] }],
]);

/** 这一趟真用到的 nmath 符号 —— 模块里只发**用到的**那几条 `(cabi …)`。 */
const cabiUsed = new Set();

/**
 * `is.na` 一族。回的是 C 的 `int`，所以外面要包一格 `!= 0` 才是布尔。
 * `is.finite` 用的是 **R 自己的** `R_finite`（nmath 里有），别的三格是我们那份
 * `rt/omni_rna.c`（R 那边它们在解释器里）。
 */
const PRED = new Map([
  /* 这两格**没有**载荷问题（`Inf` 就是 `Inf`），所以照旧按值过。 */
  ['is.infinite', 'omni_r_is_infinite'],
  ['is.finite', 'R_finite'],
]);

/**
 * **随机数那一族**（`r*`）—— 现在接了，因为发生器换成了 R 自己那一条。
 *
 * 从前这一格刻意空着：standalone 的 nmath 自带的是 Marsaglia-MultiCarry，而 R 默认是
 * Mersenne-Twister，播种法也不同 —— 接上去只会得到"看着像随机、每个数都不一样"。
 * 现在 `rt/omni_rng.c` 按 `src/main/RNG.c` 公开的算法把 MT 与 R 的播种法写出来、顶掉了
 * 那一份，于是 nmath 里这一族（**R 自己的代码**）跑在**R 自己的流**上，数与 R 逐位相同。
 *
 *   sym   —— `Rmath.h` 里的名字（**只收一格值**：`runif(a, b)` 出一个数，不是一条向量）
 *   fill  —— R 那侧除了第一个 `n` 之外的实参：`null` 是必填，别的是缺省值
 *   inv   —— R 那侧给的是 `rate`，而 C 那侧收 `scale`（`rexp(n, rate)` → `rexp(1/rate)`，
 *            这是 R 自己在 `stats/R/distn.R` 里做的换算）
 */
const RRAND = new Map([
  ['runif', { sym: 'runif', fill: [0, 1] }],
  ['rnorm', { sym: 'rnorm', fill: [0, 1] }],
  ['rexp', { sym: 'rexp', fill: [1], inv: true }],
  ['rpois', { sym: 'rpois', fill: [null] }],
  ['rbinom', { sym: 'rbinom', fill: [null, null] }],
  ['rgeom', { sym: 'rgeom', fill: [null] }],
  ['rchisq', { sym: 'rchisq', fill: [null] }],
  ['rcauchy', { sym: 'rcauchy', fill: [0, 1] }],
  ['rlnorm', { sym: 'rlnorm', fill: [0, 1] }],
  ['rt', { sym: 'rt', fill: [null] }],
  ['rbeta', { sym: 'rbeta', fill: [null, null] }],
]);

const NUM_STR = 'r_num_str';

/** 比较那六格 → 各自那一格生成出来的三态函数（见 `RLGL1` 那段账）。 */
const CMP_FNS = new Map([
  ['<', 'r_lt'], ['<=', 'r_le'], ['>', 'r_gt'], ['>=', 'r_ge'], ['==', 'r_eq'], ['!=', 'r_ne'],
]);
/** 这一批由 `lglFnDecl` 发（形状都是"几格 real 进、一格 real 出"）。 */
const LGL_FNS = new Set([
  'r_lgl', 'r_and', 'r_or', 'r_xor', 'r_not', 'r_cond', 'r_lgl_str',
  'r_is_true', 'r_is_false', 'r_ifelse1', ...CMP_FNS.values(),
]);

/**
 * **生成出来的辅助函数之间的依赖，明写成一张表。**
 *
 * 原来这儿是"往 `needFn` 里加，然后多扫几轮直到不再长" —— 那个写法出过一次真错：
 * `r_cat_vec` 在被生成的那一刻才点 `r_num_str`，而 `r_num_str` 被生成的那一刻才点
 * `r_is_na` / `r_is_nan`，于是最后那两格的 `(cabi …)` 没发出来，`NA` 被当成普通 NaN 印成
 * `NaN`。症状是**静默答错**，而根因藏在"第几轮扫到"里 —— 那种错不该靠多扫一轮去躲。
 *
 * 现在的规矩：用到哪一格就 `useFn` 它，**发之前先按这张表闭包一遍**。
 * 于是"生成的次序"不再是一件要想的事。
 */
const FN_DEPS = new Map([
  ['r_na', []],
  /* `x[k] <- v` 里 k 超长时接长那两格（值那条填 NA、名字那条填空串）。 */
  ['r_ext', ['r_na']],
  ['r_ext_nm', []],
  ['r_is_na', []],
  ['r_is_nan', []],
  ['r_num_str', ['r_is_na', 'r_is_nan', 'r_sci']],
  ['r_sci', []],
  ['r_cat_vec', ['r_num_str']],
  ['r_cat_lgl', ['r_is_na']],
  ['r_sum', []],
  /* `mean` 是**两遍**的（照 R 的 `summary.c`）—— 第二遍前要问一句有限，所以要 `r_is_na`。 */
  ['r_mean', ['r_sum', 'r_is_na']],
  /* `max` / `min` 要把 `NA` 与 `NaN` 分开记（R 的口径见那两段账），所以要问那三格。 */
  ['r_max', ['r_is_na', 'r_is_nan', 'r_na']],
  ['r_min', ['r_is_na', 'r_is_nan', 'r_na']],
  /* 下标里有 `NA` 就停下来、正负混着就停下来（见那个函数上的账）。 */
  ['r_vec_pick', ['r_is_na']],
  ['r_vec_mask', ['r_is_na', 'r_na']],
  ['r_rev', []],
  ['r_seq_along', []],
  ['r_which', ['r_is_na']],
  /* base 里"向量进向量出"那一族。`sort` 要问缺失（丢掉），`range` 要造 `NA`。 */
  ['r_sort', ['r_is_na']],
  ['r_cumsum', []],
  /* `cummax` / `cummin`：碰上缺失之后全是缺失，所以要 `r_is_na` 与 `r_na`。 */
  ['r_cummax', ['r_is_na', 'r_na']],
  ['r_cummin', ['r_is_na', 'r_na']],
  ['r_rep_len', []],
  /* `tabulate`：缺失与非正数与超出 nbins 的那几格都不记，所以要问 `r_is_na`。
     不给 `nbins` 时的那个默认长度是另一格（`r_tab_n` —— R 的默认实参是 `max(1, bin)`）。 */
  ['r_tab_n', ['r_is_na']],
  ['r_tabulate', ['r_is_na']],
  /* 不给 `nbins` 的那一格：默认长度要把那条向量读一遍，所以"读两遍"这件事塞进一格
     函数里（形参只求值一次）—— 调用点上摆不下临时量。 */
  ['r_tab_a', ['r_tabulate', 'r_tab_n']],
  ['r_any_na', ['r_is_na']],
  ['r_append', []],
  ['r_append_e', ['r_append']],
  /* `replace(x, k, v)` 就是 `x[k] <- v`，所以越界那一条也接长（借 `r_ext`）。 */
  ['r_replace', ['r_is_na', 'r_ext', 'r_na']],
  ['r_prod', []],
  ['r_range', ['r_is_na', 'r_na']],
  ['r_diff', []],
  /* `rank`：并列取平均，所以要问"算不算同一格"（`r_same`）；缺失排在最后（`r_is_na`）。 */
  ['r_rank', ['r_is_na', 'r_same']],
  /* 位运算那一族（`bitwAnd` …）。R 的整数是**32 位**的，而这一档的 `int` 是 64 位 ——
     所以每一格进出都过一道 `r_bit_v`：出了 32 位就当场报（R 那边它是 `NA_integer_`，
     而整数的缺失这一档还没有，见 SPEC 第四节第 11 条）。 */
  ['r_bit_v', []],
  ['r_bit_and', ['r_bit_v']],
  ['r_bit_or', ['r_bit_v']],
  ['r_bit_xor', ['r_bit_v']],
  ['r_bit_not', ['r_bit_v']],
  ['r_bit_shl', ['r_bit_v']],
  ['r_bit_shr', ['r_bit_v']],
  ['r_head', []],
  ['r_tail', []],
  ['r_var', ['r_mean']],
  ['r_sd', ['r_var', 'r_mean']],
  /* `median`：先排（`r_sort` 顺手把缺失丢了）再取中间那一格/两格的平均。缺失那一条要
     **在排之前**问（`na.rm = FALSE` 时 R 答 `NA`，而排完就看不出原来有没有缺失了）。 */
  ['r_median', ['r_sort', 'r_any_na', 'r_na']],
  /* `cov` / `cor`：两条一样长的向量。`cor` 的分母照 R 的 `cov.c`——**两个 sqrt 分开乘**
     （不是 `sqrt(varx*vary)`），最后一位就靠这个对上。 */
  /* `quantile` 的 type 7（照 `quantile.default` 抄）+ 不给 `probs` 时那五格。 */
  ['r_zap', ['r_is_na']],
  ['r_qdef', []],
  ['r_no_na', ['r_any_na']],
  ['r_quantile', ['r_sort']],
  ['r_cov', ['r_mean']],
  ['r_cor', ['r_cov', 'r_var', 'r_mean']],
  ['r_rep_s', []],
  ['r_rep_v', []],
  ['r_rep_str', []],
  ['r_seq_n', []],
  ['r_seq_by', []],
  ['r_sample_i', []],
  ['r_zeros', []],
  /* `as.integer(向量)` —— 逐元素朝零截，缺失原样留着（所以要问 `r_is_na`）。 */
  ['r_as_int_v', ['r_is_na']],
  /* 字符向量那一族（`(arr string)`，见 `RSTRV`）。各自都是自足的 —— 串这一侧没有 `NA`。 */
  ['r_cat_str', []],
  ['r_print_str', []],
  ['r_join_str', []],
  ['r_rev_str', []],
  ['r_iota', []],
  ['r_nchar_v', []],
  ['r_upper_v', []],
  ['r_lower_v', ['r_lower']],
  ['r_lower', []],
  ['r_pick_str', []],
  ['r_mask_str', ['r_is_na']],
  ['r_drop_na', ['r_is_na']],
  /* 集合与位置那一族（`match` / `%in%` / `unique` / `order`…）。"两格值算不算同一格"
     单独一个函数（`r_same`）—— R 里 `NA` 与 `NA` 算同一格、`NaN` 与 `NaN` 算同一格，
     而按 `==` 比这两对都是假（浮点的规矩），所以那一问不能摊在调用点上写。 */
  ['r_same', ['r_is_na', 'r_is_nan']],
  ['r_which_max', ['r_is_na']],
  ['r_which_min', ['r_is_na']],
  ['r_cumprod', []],
  ['r_pmax', ['r_is_na', 'r_na']],
  ['r_pmin', ['r_is_na', 'r_na']],
  ['r_ord_lt', ['r_is_na']],
  ['r_order', ['r_ord_lt']],
  ['r_match', ['r_same', 'r_na']],
  ['r_in_v', ['r_same']],
  ['r_in1', ['r_same']],
  ['r_unique', ['r_same']],
  ['r_dup', ['r_same']],
  ['r_any_dup', ['r_same']],
  /* 这三格的体里用 `r_in1` 问"另一条里有没有这一格"（`setFnDecl2` 的 `inW`）——
     登记漏了的话它只在"源码里还另有一处 `%in%`"时凑巧能链上（量出来的：`print.R` 里
     单写 `intersect(1:2, 3:4)` 报 `未声明的函数 'r_in1'`）。 */
  ['r_union', ['r_same', 'r_in1']],
  ['r_intersect', ['r_same', 'r_in1']],
  ['r_setdiff', ['r_same', 'r_in1']],
  /* `setequal(a, b)` = 两边各问一遍"另一条里有没有这一格"；`findInterval` 数的是
     "有几格断点 <= 这一格"。两格都在集合那一族里（`setFnDecl2`）。 */
  ['r_setequal', ['r_same', 'r_in1']],
  ['r_find_int', ['r_is_na', 'r_na']],
  /* 三态逻辑那一族（`RLGL1` 那段账）。比较那六格各发一个函数 —— 不摊在调用点上是
     因为"两边各读两遍"要临时量，而临时量在**条件位**上没地方摆（`while` 的条件被降级到
     循环外头，摊开的 `let` 会变成"只算一次"）。一次函数调用是纯表达式，哪儿都放得下。 */
  ['r_lgl', ['r_is_na', 'r_na']],
  ['r_and', ['r_is_na', 'r_na']],
  ['r_or', ['r_is_na', 'r_na']],
  ['r_xor', ['r_is_na', 'r_na']],
  ['r_not', ['r_is_na', 'r_na']],
  ['r_cond', ['r_is_na']],
  ['r_is_true', ['r_is_na']],
  ['r_is_false', ['r_is_na']],
  ['r_ifelse1', ['r_is_na', 'r_na']],
  ['r_ifelse', ['r_is_na', 'r_na']],
  /* 两支是串那一档：test 里有 NA 就停下来（没有 `NA_character_`），所以要问 `r_is_na`。 */
  ['r_ifelse_s', ['r_is_na']],
  ['r_vec1', []],
  /* 串那一族（`substr` 要量长度、`startsWith` 要读两遍、`sprintf` 的宽度要补空格）。 */
  ['r_substr', []],
  ['r_starts', []],
  ['r_ends', []],
  ['r_padl', []],
  /* `format(一格数)`：底子是 `r_num_str`（7 位），`nsmall=` 那一格要问缺失与无穷。 */
  ['r_format1', ['r_num_str', 'r_is_na']],
  ['r_padr', []],
  ['r_pad0', []],
  ['r_trim', []],
  /* 串那一族在字符向量上逐元素 —— 每一格转给标量那一版。 */
  ['r_substr_v', ['r_substr']],
  /* base 那四条字符向量常量（各自自足 —— 一串 `apush` 而已）+ `strrep` 逐元素那一格。 */
  ['r_sv_letters', []],
  ['r_sv_upper', []],
  ['r_sv_month', []],
  ['r_sv_mabb', []],
  ['r_strrep_v', []],
  ['r_trim_v', ['r_trim']],
  /* `chartr`：两张字符表查一遍（与 `r_lower` 同一条办法），向量那一格逐元素。 */
  ['r_chartr', []],
  ['r_chartr_v', ['r_chartr']],
  /* `as.character(向量)`：数那一档走 `r_num_str`（15 位），逻辑那一档走 `r_lgl_str`；
     两格都要问缺失（碰上就当场报 —— 没有 `NA_character_`）。 */
  /* 字符向量上"只要相等、不要 collation"那一族（`sort` / `order` 照旧当场报）。 */
  ['r_sv1', []],
  /* 字符向量的 `sort(method="radix")` / `order(method="radix")`：按字节比（C locale）。 */
  ['r_sort_str', []],
  ['r_order_str', []],
  ['r_any_dup_str', []],
  ['r_uniq_str', []],
  ['r_dup_str', []],
  ['r_match_str', ['r_na']],
  ['r_in_str', []],
  ['r_in1_str', []],
  ['r_union_str', ['r_in1_str']],
  ['r_isect_str', ['r_in1_str']],
  ['r_sdiff_str', ['r_in1_str']],
  ['r_head_str', []],
  ['r_tail_str', []],
  ['r_as_str_v', ['r_is_na', 'r_num_str']],
  ['r_as_str_lv', ['r_is_na', 'r_lgl_str']],
  ['r_starts_v', ['r_starts']],
  ['r_ends_v', ['r_ends']],
  ['r_split', []],
  /* 找与换那一族（见 `findOf`）。`r_gsub` 是 `sub` 与 `gsub` 共用的那一个（带"换几次"的旗子）。 */
  ['r_gsub', []],
  ['r_gsub_v', ['r_gsub']],
  ['r_grepl_v', []],
  ['r_grep_i', []],
  ['r_grep_s', []],
  ['r_lgl_str', ['r_is_na']],
  ['r_any', ['r_is_na', 'r_na']],
  ['r_all', ['r_is_na', 'r_na']],
  /* `print` 那一族：向量共用一套宽度，所以两个印法都要 `r_sci` 与逐格排版那一格。 */
  ['r_num_fmt', ['r_is_na', 'r_is_nan']],
  ['r_print_num', ['r_sci', 'r_is_na', 'r_is_nan', 'r_num_fmt']],
  ['r_print_lgl', ['r_is_na', 'r_lgl_str']],
  /* 带名字的向量那三格（见 `RNVEC`）：印是"名字一行、值一行"，名字那条空着就退回
     `r_print_num`（R 里名字被丢掉之后印的就是 `[1] …`）。 */
  ['r_print_named', ['r_sci', 'r_is_na', 'r_is_nan', 'r_num_fmt', 'r_print_num']],
  ['r_at_name', ['r_na']],
  ['r_nm_at', []],
  ...[...CMP_FNS.values()].map((n) => [n, ['r_is_na', 'r_na']]),
]);

/* ─── 类型（标准 IR 的类型描述，§1.2） ─────────────────────────────────── */

const INT = { kind: 'int' };
const REAL = { kind: 'real' };
const STR = { kind: 'string' };
const BOOL = { kind: 'bool' };
const arrOf = (value) => ({ kind: 'arr', elem: value });   /* 只给字典的值类型用了 */
/** R 的 `list` 带名字用就是关联表 —— 键一律是串。 */
const dictOf = (value) => ({ kind: 'map', key: STR, value });

/**
 * R 的名字规整成方言收得下的形状：`.` 是 R 里合法的名字字符（`is.null` / `max.2`），
 * 方言那侧不收。反引号那一支已经由词法层剥干净（`(string SYMBOL "`")`），
 * 所以这儿只管字符替换。与 `ext/chez/adapter` 把 `-` / `?` / `!` 换成 `_` 是同一手。
 */
const mangle = (s) => String(s).replace(/[.]/g, '_');

/** `(sym x)` / `(str x)` / 裸记号都要认（形参表、命名实参那几处是后者）。 */
const nameOf = (x) => {
  const t = tag(x);
  if (t === 'sym' || t === 'str') return leaf(kids(x)[0]);
  return leaf(x);
};

/* ─── 字面量 ───────────────────────────────────────────────────────────── */

/** R 的关键字里 `TRUE` / `FALSE` / `NA` / `Inf` / `NaN` 都是 NUM_CONST（gram.y:2176）。 */
const CONSTS = new Map([
  ['TRUE', { kind: 'bool', value: true }],
  ['FALSE', { kind: 'bool', value: false }],
]);

/**
 * base 里那几个**有名字的常量**。它们在 R 那边是普通的变量（`pi` 就是 `base::pi`，
 * `T` / `F` 也是变量、能被赋值盖掉），所以这儿的规矩是：**这一段写过这个名字就不算这张表**。
 *
 * 口径差别照实说：这一档没有声明，被赋值的名字是在**段顶**补 `let` 的（文件头第 3 条），
 * 所以 `T <- 5` 会把整段的 `T` 都变成那格变量 —— 包括赋值**之前**那几句
 * （R 在那几句里读到的还是 `TRUE`）。这一格与"变量在赋值前读到零值"是同一个来源。
 *
 * 数值那三格在这张表里；`LETTERS` / `month.name` 那一批是**字符向量**，装在
 * `BASE_SVAR` 里（那张表要等 `RSTRV` 先定义出来，所以摆在后头）——
 * 两张表由 `baseVar()` 一起查。
 */
const BASE_VARS = new Map([
  ['pi', { expr: { kind: 'real', value: Math.PI }, type: REAL }],
  ['T', { expr: { kind: 'bool', value: true }, type: BOOL }],
  ['F', { expr: { kind: 'bool', value: false }, type: BOOL }],
]);

/** 那四条常量各自装的是什么（`strvFnDecl` 按这张表发函数）。 */
const BASE_SV = new Map([
  ['r_sv_letters', [...'abcdefghijklmnopqrstuvwxyz']],
  ['r_sv_upper', [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']],
  ['r_sv_month', ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']],
  ['r_sv_mabb', ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']],
]);

/**
 * R 的三格"非数"。它们**不是字面量** —— `NA` 的位模式（NaN + 低 32 位 1954）写不进
 * `(real …)`，方言里也没有位重解释那一格。所以由 `rt/omni_rna.c` 那三个函数答，
 * 与 `round` 走 `fround` 是同一条路：拿不到的东西不自己编一个近似的。
 *
 * `NA_integer_` / `NA_character_` / `NA_complex_` **没接**：整数与串的 NA 在 R 那边是
 * 另外两种表示（`INT_MIN` 与一格特殊的 CHARSXP），而我们还没有"带缺失的整数/串"这一层。
 */
const NONNUM = new Map([
  ['NaN', 'omni_r_nan'],
  ['Inf', 'omni_r_posinf'],
]);

/**
 * **R 的 double 按指针过 FFI，不按值。**
 *
 * `NA_real_` 是"带 1954 载荷的 NaN"（*R Internals* §1.3），而那个载荷**按值过 N-API 会被
 * V8 规范化掉**（`napi_create_double` 那一步）。量出来的三格：
 *   * C 里直接调：`is_na=1 is_nan=0`（对）
 *   * 按值过一趟 `(ccall omni_r_na)`：`is_na=1 is_nan=1`（NA 变成了普通 NaN）
 *   * **按指针**（`(pnew (ptr real) 1)` + `(ccall … (var p))`）：`1 0`，而且 `pload` 出来
 *     的那格 JS 数再 `pstore` 回另一段内存，还是 `1 0` —— 载荷分毫不动
 *
 * 所以 `NA` 这一族走 `(ptr real)`：值留在线性内存里，两边按位读写，绕开装箱那一步。
 * 三格封在下面那三个**生成出来的函数**里（`r_na` / `r_is_na` / `r_is_nan`），
 * 调用点照旧写 `NA` / `is.na(x)` —— 指针那套不往上冒。
 */
const PTR_REAL = { kind: 'ptr', inner: REAL };

/**
 * **R 的数值向量 = 一段线性内存，长度存在 0 号槽里。**
 *
 * 为什么不是 `(arr real)`：那一格后端落成 JS 数组，而**只装 double 的 JS 数组会把 NaN
 * 的载荷抹掉**（V8 的 PACKED_DOUBLE_ELEMENTS 必须规范化 NaN —— 那种数组里"洞"本身就是
 * 一个特殊 NaN）。于是 `c(1, NA, 3)` 会印成 `1 NaN 3`。量出来的五种存法与判据在
 * `tests/r/oracle.js` 第三节。
 *
 * 为什么长度存在槽里、而不是另开一个结构体：向量要能当**一个值**进出函数（形参、返回值、
 * 存进字典），而结构体那条路要多一份 `(struct …)` 声明与 `fld` / `fldset`。
 * 长度写在头上是 R 自己的做法（SEXP 的 header 里就有 length），而且一格 double 装得下
 * 2^53 以内的长度 —— 比任何真向量都长。
 *
 *   槽 0      长度（按 double 存）
 *   槽 1..n   元素
 */
const RVEC = PTR_REAL;
/**
 * **逻辑向量**跟数值向量同一个存法（`(ptr real)`，1.0 / 0.0 / NA），只在这一侧的类型上
 * 多带一个记号 —— 差别只在**印法**：R 印 `TRUE` / `FALSE` / `NA`，不印 `1` / `0`。
 * `typeToSx` 只看 `kind` 与 `inner`，所以这个记号不会漏到 `.sx` 里去。
 */
const RLGL = { kind: 'ptr', inner: REAL, lgl: true };
/**
 * **一格逻辑标量**（`x > 2` 的那种）：跟逻辑向量同一个理由，存的是 double 的
 * 1.0 / 0.0 / NA，类型上多带一个记号。
 *
 * 为什么不是方言的 `bool`：R 的逻辑是**三态**的（`NA > 2` 是 `NA`，不是 `FALSE`），
 * 而 `bool` 装不下缺失。从前这一格是 `bool`，于是 `cat(NaN > 2)` 我们印 `FALSE`
 * 而 R 印 `NA` —— 那是**静默答错**。
 *
 * 两边都是 int 的比较仍然回 `bool`：这一档的 int 没有 `NA_integer_`（明写在 SPEC），
 * 而 `while (i <= n)` 是循环里最热的一格，不值得为一个到不了的状态多绕一趟。
 */
const RLGL1 = { kind: 'real', lgl: true };
const isVecTy = (t) => t !== undefined && t !== null && t.kind === 'ptr';
const isLglTy = (t) => isVecTy(t) && t.lgl === true;
const isLgl1 = (t) => t !== undefined && t !== null && t.kind === 'real' && t.lgl === true;
/**
 * **字符向量** —— 一条 `(arr string)`，0 起，长度问 `alen`。
 *
 * 为什么不跟数值向量一个存法（`(ptr real)` + 槽 0 装长度）：那条路是为了**NaN 的载荷**
 * 才走的（`NA` 是一个特殊 NaN，只有线性内存留得住它的载荷，见上面那段账）。串这一侧
 * 没有这个问题 —— 方言的 `(arr string)` 自带长度（`alen`）、`apush` 还能现长，
 * 于是"攒一串名字"那种写法（`out <- c(out, s)`）不必先算总长。
 *
 * 代价是**两种向量两套代码**：`length` / `c` / `cat` / `print` / `for … in` 都要各写一档。
 * 换来的是"串不必先编码成 double 再解码"，而那条路要一张字符串表，这一版没有。
 * `NA_character_` 没有（见 SPEC §4 第 11 条）—— 空串就是空串，不是缺失。
 */
const RSTRV = { kind: 'arr', elem: STR };
const isStrVec = (t) => t !== undefined && t !== null && t.kind === 'arr';
/**
 * base 里那四条**字符向量**常量（`BASE_VARS` 的后一半 —— 这儿才有 `RSTRV`）。
 *
 * `expr` 换成 `mk`（一格工厂）：造一条 `(arr string)` 要一串 `apush`，那是语句、摆不进
 * 一格字面量里，所以落成一次函数调用。摆成工厂而不是现成的表达式，是因为 `useFn` 一执行
 * 就把那个函数记进"这一趟要发的"——在表构造时执行就会塞进**每一份**程序里。
 */
const BASE_SVAR = new Map([
  ['letters', { mk: () => lglCall('r_sv_letters'), type: RSTRV }],
  ['LETTERS', { mk: () => lglCall('r_sv_upper'), type: RSTRV }],
  /* `.` 在这一层被 `mangle` 换成 `_`，所以键是 `month_name` 而不是 `month.name`。 */
  ['month_name', { mk: () => lglCall('r_sv_month'), type: RSTRV }],
  ['month_abb', { mk: () => lglCall('r_sv_mabb'), type: RSTRV }],
]);
/** 两张 base 常量表一起查（数值那三格在 `BASE_VARS`、字符向量那四条在 `BASE_SVAR`）。 */
const baseVar = (nm) => BASE_VARS.get(nm) ?? BASE_SVAR.get(nm);
const baseVarExpr = (e) => (e.mk !== undefined ? e.mk() : e.expr);
/**
 * **带名字的数值向量**（`c(a = 1, b = 2)`）—— 值那一条还是 `(ptr real)`，名字另走一条
 * `(arr string)`，两条**跟着同一个变量**：`v` 的名字摆在 `v__nm` 里。
 *
 * 为什么是"跟着变量"而不是"跟着值"：R 的名字是**属性**（挂在 SEXP 上），要跟着值走就得给
 * 每一格向量带一个头（结构体 + `fld` / `fldset`，每一处向量算子都要改）。而真代码里名字
 * 几乎总是挂在一个有名字的量上（`counts <- c(a = 1, b = 2)`），所以这一档只做那一半：
 * 名字跟着**名字**走。跟不住的地方（`sort(v)` 那种要把名字也排一遍的）**当场报**，
 * 不静默把名字丢掉 —— 丢了之后 `print` 出来与 R 差两行。
 *
 * `named` 这个记号 `typeToSx` 看不见（它只看 `kind` 与 `inner`），与 `lgl` 同一条路子。
 */
const RNVEC = { kind: 'ptr', inner: REAL, named: true };
/** `v > 1` 那一格：**带名字的逻辑向量**（R 也把名字带过去）。这一档印不出来 —— 当场报。 */
const RNLGL = { kind: 'ptr', inner: REAL, lgl: true, named: true };
/**
 * **整数向量**那个记号（`typeToSx` 看不见它，与 `lgl` / `named` 同一条路子）。
 *
 * 存法与数值向量完全一样（还是 `(ptr real)`）—— 这个记号只管**一件事**：零长向量印出来的
 * 那个类型名。R 印的是**元素类型**（量出来的，`Rscript`，2026-09-25）：
 * `which(x > 5)` / `seq_len(0)` / `order(numeric(0))` / `nchar(character(0))` 印
 * `integer(0)`，而 `numeric(0)` / `c(1:2, 3)[0]` 印 `numeric(0)`。
 * 非零长那一档两者印得一样，所以这个记号只影响那一行字。
 *
 * 从前没有它，于是 `print(which(x > 5))` 印的是 `numeric(0)` —— 静默与 R 差一行字。
 */
const RIVEC = { kind: 'ptr', inner: REAL, ivec: true };
const isIvecTy = (t) => t !== undefined && t !== null && t.kind === 'ptr' && t.ivec === true;
/** 零长时印的那个类型名（`formatReal` 之外的一行字，见 `RIVEC`）。 */
const zeroName = (t) => (isIvecTy(t) ? 'integer(0)' : 'numeric(0)');
const isNamedTy = (t) => t !== undefined && t !== null && t.kind === 'ptr' && t.named === true;
/** 那个影子变量的名字（`v` 的名字在 `v__nm` 里）。 */
const nmVar = (v) => `${v}__nm`;
/**
 * **名字丢得掉的那几格** —— R 自己也丢，所以这一档丢了不差字节。量出来的（`Rscript`，
 * 2026-09-25）：`range` / `unique` / `seq_along` / `as.character` / `paste` 都回没名字的，
 * 而 `sort` / `rev` / `head` / `cumsum` / `abs` / `sqrt` / `round` / `is.na` / `c(v, 4)`
 * **都把名字带过去**。表外的名字收到带名字的向量就**当场报** —— 静默丢掉的话
 * `print` 少印一行（两行版式变成 `[1] …`），而那是最难查的一种错。
 */
const NAME_DROP_OK = new Set([
  'names', 'setNames', 'unname', 'print', 'invisible', 'cat',
  'paste', 'paste0', 'sprintf', 'length', 'sum', 'mean', 'max', 'min', 'prod',
  'var', 'sd', 'range', 'any', 'all', 'unique', 'seq_along', 'seq_len',
  'as.character', 'as.numeric', 'as.integer',
  'is.numeric', 'is.character', 'is.logical', 'stop', 'stopifnot',
]);
/** 第 i 格（0 起）。方言的 `{kind:'index'}` 落成 `(aget …)`，赋值那侧落 `(aset …)`。 */
const svGet = (v, i) => ({ kind: 'index', obj: v, index: i });
const svLen = (v) => call1('alen', v);
/**
 * 字符向量上**还没接**的那些函数，报一句有名有姓的。
 *
 * 为什么 `sort` 不接：R 排串按**locale 的排序规则**（`Scollate`），不是按字节 ——
 * `sort(c("pear","apple","Banana"))` 在 R 那边是 `"apple" "Banana" "pear"`，
 * 按字节比的话 `"Banana"` 会跑到最前面。要对上得先有那套 collation，这一版没有，
 * 所以**当场报**而不是给一个"看着像排好了"的答案（那是静默答错）。
 */
const strvGap = (fn) => `r->IR: ${fn}() 在字符向量上还没接`
  + '（排序要 R 的 locale collation、其余几格要"按下标挑"那一层，见 ext/r/SPEC.md 第四节第 12 条）';
/** 第 i 格元素的地址（`i` 从 0 数，所以要 +1 跳过长度那一格）。 */
const vecAt = (v, i) => call1('padd', v, i.kind === 'int'
  ? { kind: 'int', value: i.value + 1 }
  : b('+', i, { kind: 'int', value: 1 }));
const vecGet = (v, i) => ({ kind: 'deref', expr: vecAt(v, i) });
const vecSet = (v, i, x) => ({ kind: 'assign', target: { kind: 'deref', expr: vecAt(v, i) }, value: x });
const vecLen = (v) => call1('toint', { kind: 'deref', expr: v });
/**
 * 开一格长度为 `n` 的向量、绑到名字 `nm` 上：`n+1` 个槽，0 号写长度。回那两条语句。
 * `n` 是一格 int 表达式（字面量就折一下）。
 */
function vecNewAs(nm, n) {
  const v = { kind: 'name', name: nm };
  const slots = n.kind === 'int' ? { kind: 'int', value: n.value + 1 } : b('+', n, { kind: 'int', value: 1 });
  return [
    { kind: 'let', name: nm, type: RVEC, init: call1('pnew', tyArg(RVEC), slots) },
    { kind: 'assign', target: { kind: 'deref', expr: v }, value: asReal(n, INT) },
  ];
}

/**
 * **把几段摊平成一条数值向量**（`c(…)` 就是它，`sum` / `max` 那几格"任意多实参"也是它）。
 *
 * `parts` 的每一格要么是 `{vec:false, value}`（一格标量表达式），要么是
 * `{vec:true, name}`（**已经存进临时量**的一条向量 —— 那几条 `let` 由调用方摆在 `pre` 里，
 * 因为长度与取值各要读一遍，不能把那格表达式求两次）。
 *
 * 方言里"造"与"填"是两件事（`pnew` 是值、`pstore` 是语句），所以回的是一格 `block-expr`。
 */
function numCatOf(pre, parts) {
  const vr = (nm) => ({ kind: 'name', name: nm });
  /* 总长度：标量那几格是常数，先加起来（`.sx` 里就少一串 `(bin "+" … (int 1))`）。 */
  const flat = parts.filter((p) => !p.vec).length;
  const len = parts.filter((p) => p.vec)
    .reduce((acc, p) => b('+', acc, vecLen(vr(p.name))), { kind: 'int', value: flat });
  const tmp = fresh('vec');
  const stmts = [...pre, ...vecNewAs(tmp, len)];
  const out = vr(tmp);
  if (parts.every((p) => !p.vec)) {
    /* 全是标量：下标是字面量，不必要那格写指针。 */
    parts.forEach((p, i) => stmts.push(vecSet(out, { kind: 'int', value: i }, p.value)));
    return { kind: 'block-expr', stmts, value: out };
  }
  const k = fresh('ck');
  stmts.push({ kind: 'let', name: k, type: INT, init: { kind: 'int', value: 0 } });
  const bump = { kind: 'assign', target: vr(k), value: b('+', vr(k), { kind: 'int', value: 1 }) };
  for (const p of parts) {
    if (!p.vec) {
      stmts.push(vecSet(out, vr(k), p.value), bump);
      continue;
    }
    const j = fresh('cj');
    stmts.push({
      kind: 'for',
      init: { kind: 'let', name: j, type: INT, init: { kind: 'int', value: 0 } },
      cond: b('<', vr(j), vecLen(vr(p.name))),
      post: { kind: 'assign', target: vr(j), value: b('+', vr(j), { kind: 'int', value: 1 }) },
      body: [vecSet(out, vr(k), vecGet(vr(p.name), vr(j))), bump],
    });
  }
  return { kind: 'block-expr', stmts, value: out };
}
const NA_FNS = new Map([
  ['r_na', 'omni_r_na_into'],
  ['r_is_na', 'omni_r_is_na_p'],
  ['r_is_nan', 'omni_r_is_nan_p'],
]);
/** 这一趟要发哪几格生成出来的辅助函数。 */
const needFn = new Set();
const useFn = (name) => { needFn.add(name); return name; };

/**
 * **用户函数的形参与返回类型**（`ext/r/adapter.js` 文件头第 4 条那一格的第二半）。
 *
 * R 的函数没有类型标注，而方言那一层不推导只检查 —— 所以"`f` 的形参装什么、回什么"
 * 必须在这儿答完。答案只能从**调用点**来：`half <- function(x) x / 2` 里 `x` 是什么，
 * 要看 `half(3)` 传的是什么。于是这两张表由 `inferFns()` 扫一遍全程序填出来，
 * 转两轮到不动点（`f` 调 `g`、`g` 又调 `f` 那种要第二轮才定得住）。
 *
 * 从前这一格是"形参一律 int、回值一律 int"，于是 `addone(c(1,2,3))` 当场报
 * "第 1 个形参是 int，给的是 real*"，而 `f <- function(x) x > 2` 之后 `cat(f(1))`
 * 印方言自己那套 `false`。
 */
const fnParams = new Map();
const fnRets = new Map();
/**
 * **形参默认值**（`function(x, n = 10)`）：名字 → 一排"默认值的树 或 null"。
 *
 * R 里那个默认值是一格 **promise**：在函数体里第一次用到时才求值、而且是在**函数自己的
 * 环境**里求（所以 `function(x, y = x)` 是合法的）。这一档没有 promise，也没有
 * "少传几个实参"那种可变元数（方言里函数的元数是定死的）—— 所以这儿的做法是
 * **在调用点把缺的那几格填上默认值那棵树**。
 *
 * 两条由此来的规矩：
 *   * 默认值里**不许引用这个函数自己的形参**（`function(x, y = x)` 当场报）——
 *     那要真的 promise：调用点上还没有 `x` 这个名字。
 *   * 默认值是在**调用点**求值的（R 是在被调方求）。对常量那一档（`n = 10`、
 *     `sep = ", "`、`tol = 1e-8`，真代码里几乎全是这一档）两者同结果。
 */
const fnDefs = new Map();
/** 名字 → 形参名字表（调用点要按名字配实参，所以这张也得留着）。 */
const fnFormals = new Map();

/**
 * **顶层那些被函数用到的名字**（名字 → 类型）—— 它们落成方言的**模块级变量**
 * （`(global 名字 类型)`），不是 `main` 的局部量。
 *
 * 为什么必须分开：R 的函数能看见顶层的名字（词法作用域到 global env），
 * 而 `main` 的局部量在别的函数里**根本不存在**（方言那侧会报"未声明的变量"）。
 * 记忆化那一格就压在这儿：`memo <- numeric(40)` 在顶层，`fibm` 里要读也要写它。
 *
 * 三条规矩（与 R 一致）：
 *   * 函数里用 `<-` 赋值的名字是**局部**的，哪怕顶层有同名的那一格（R 的规矩）——
 *     于是那一格 `let` 把全局遮住；
 *   * 只读的名字看见的是全局；
 *   * `<<-` 写的是**全局**（这一格从前当普通赋值，于是悄悄写进了局部）。
 *
 * 零初始化：方言的模块级变量按设计没有初值，所以向量那几格的"开一段内存 + 长度 0"
 * 摆在 `main` 的开头（与从前 `let` 带初值是同一串语句，只是换成了 `set`）。
 */
const globalTys = new Map();

/**
 * **把一次调用的实参配到形参上**（R 的规矩：命名实参先按名字对上，剩下的位置实参
 * 按顺序填空位，还空着的用默认值）。回一排"实参的树"，`extra` 那一格用 `null` 占位
 * （`|>` 塞到第一位的那个值）。配不上就当场报 —— 不猜。
 */
function bindArgs(fname, pnames, defs, callNode, hasExtra) {
  const bound = new Array(pnames.length).fill(undefined);
  const as = argsOf(callNode);
  for (const a of as) {
    if (a.name === null) continue;
    const k = pnames.indexOf(mangle(a.name));
    if (k < 0) throw new Error(`r->IR: ${fname}() 没有叫 \`${a.name}\` 的形参`);
    bound[k] = a.value;
  }
  const pos = [...(hasExtra ? [null] : []), ...as.filter((a) => a.name === null).map((a) => a.value)];
  let pi = 0;
  for (let k = 0; k < bound.length && pi < pos.length; k++) {
    if (bound[k] === undefined) { bound[k] = pos[pi]; pi += 1; }
  }
  if (pi < pos.length) {
    throw new Error(`r->IR: ${fname}() 只有 ${pnames.length} 个形参，给了 ${pos.length} 格位置实参`);
  }
  bound.forEach((node, k) => {
    if (node !== undefined) return;
    const d = defs[k];
    if (d === null || d === undefined) {
      throw new Error(`r->IR: ${fname}() 的形参 \`${pnames[k]}\` 没给值，而它也没有默认值`
        + '（R 那边是"用到才报 argument is missing"，这一档在编译期就报）');
    }
    bound[k] = d;
  });
  return bound;
}

/** 调一格生成出来的辅助函数（顺手把它记进 `needFn`）。 */
const lglCall = (name, ...args) => ({ kind: 'call', fn: { kind: 'name', name: useFn(name) }, args });

/**
 *
 */

/** 一格 NUM_CONST 的文本 → 标准 IR 的字面量。写法定类型，见文件头第 4 条。 */
function numLit(text) {
  const t = String(text);
  const c = CONSTS.get(t);
  if (c !== undefined) return c;
  if (NONNUM.has(t)) {
    const sym = NONNUM.get(t);
    cabiUsed.add(sym);
    rmathSig(sym);
    return { kind: 'ccall', sym, args: [] };
  }
  if (t === 'NA' || t === 'NA_real_') {
    return { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] };
  }
  if (t.startsWith('NA_')) {
    throw new Error(`r->IR: ${t} 还没接 —— 整数与串的 NA 在 R 那边是另外两种表示`
      + '（`INT_MIN` 与一格特殊的 CHARSXP），而我们还没有"带缺失的整数/串"那一层');
  }
  if (t.endsWith('i')) throw new Error(`r->IR: 复数还没接：${t}`);
  if (t.endsWith('L')) return { kind: 'int', value: Number(t.slice(0, -1)) };
  if (/^0[xX]/.test(t)) return { kind: 'int', value: Number(t) };
  if (t.includes('.') || /[eE]/.test(t)) return { kind: 'real', value: Number(t) };
  return { kind: 'int', value: Number(t) };
}

/**
 * **每个内建认得哪些命名实参**。表外的名字当场报 —— 从前是静默丢掉，而
 * `sum(x, na.rm = TRUE)` 被丢掉之后答的是 `NA`（R 答 4），那是静默答错。
 *
 * 只登记"真的接住了"的那些。R 那边还有一大把（`decreasing=` / `each=` / `length.out=` /
 * `na.last=` / `digits=` / `quote=`…）—— 它们**不在这张表里**，于是当场报，不猜。
 */
const NA_RM = new Set(['na.rm']);
const NAMED_OK = new Map([
  ['cat', new Set(['sep'])],
  ['paste', new Set(['sep', 'collapse'])],
  ['paste0', new Set(['sep', 'collapse'])],
  ['sum', NA_RM], ['prod', NA_RM], ['mean', NA_RM], ['max', NA_RM], ['min', NA_RM],
  ['range', NA_RM], ['var', NA_RM], ['sd', NA_RM], ['any', NA_RM], ['all', NA_RM],
  ['median', NA_RM],
  ['quantile', new Set(['probs', 'names', 'na.rm', 'type'])],
  ['zapsmall', new Set(['digits'])],
  ['diff', new Set(['lag'])],
  ['casefold', new Set(['upper'])],
  ['format', new Set(['nsmall', 'width'])],
  ['trimws', new Set(['which'])],
  ['nchar', new Set(['type'])],
  /* `sort` 上**没有** `na.rm=` —— R 自己都报"参数没有用(na.rm = TRUE)"（它的默认
     `na.last = NA` 已经是"丢掉缺失"了）。量出来的：我们本来跟着收了，比 R 宽。 */
  ['head', new Set(['n'])], ['tail', new Set(['n'])],
  ['rep', new Set(['times', 'each'])],
  ['seq', new Set(['by', 'length.out'])],
  ['sort', new Set(['decreasing', 'method'])],
  ['order', new Set(['method'])],
  ['strsplit', new Set(['fixed'])],
  ['grepl', new Set(['fixed'])], ['sub', new Set(['fixed'])], ['gsub', new Set(['fixed'])],
  ['grep', new Set(['fixed', 'value'])],
  ['numeric', new Set(['length'])], ['double', new Set(['length'])],
  ['integer', new Set(['length'])], ['logical', new Set(['length'])],
  ['character', new Set(['length'])],
  ['tabulate', new Set(['nbins'])],
  ['append', new Set(['after'])],
]);

/**
 * **数字节而不是数字符的那几格**（见 `callOf` 里那段账）。`cat` / `paste` / `grepl` /
 * `startsWith` 按字节办也对（拼接与定串查找与码位无关），所以不在这张表里。
 */
const BYTEWISE = new Set(['nchar', 'substr', 'substring', 'toupper', 'tolower', 'sprintf',
  'chartr', 'casefold',
  /* `sort` / `order` 的 radix 那一档按字节比，而 JS 那侧 `<` 比的是 UTF-16 码元 ——
     非 ASCII 上两种次序会分家，所以串字面量里有非 ASCII 就在调用点当场报。 */
  'sort', 'order']);

/* ─── 内建（表外的名字当用户函数调） ──────────────────────────────────────
 *
 * 这张表是**判据**，不是方便：R 的内建在树上与用户函数完全同形（`length(x)` 与 `f(x)`
 * 一个形状），分开它们只能靠名字。表外的名字照调 —— 于是"哪些内建接上了"这件事
 * 有一处说法，而不是散在 `exprOf` 的一串 if 里。
 */
const BUILTINS = new Set([
  'cat', 'paste', 'paste0', 'c', 'list', 'length', 'nchar', 'return', 'is.null',
  'as.integer', 'as.numeric', 'as.character', 'abs', 'seq_len', 'is.na', 'is.nan',
  'sum', 'mean', 'max', 'min', 'rev', 'seq_along', 'which', 'any', 'all',
  'print', 'invisible', 'xor', 'isTRUE', 'isFALSE', 'ifelse',
  /* base 里"向量进向量出"那一族 + 两格统计量。`seq` 与 `rep` 是造向量的。 */
  'sort', 'cumsum', 'prod', 'range', 'diff', 'head', 'tail', 'var', 'sd', 'rep', 'seq', 'rep_len',
  /* 两条向量的那两格统计量（`var(x, y)` 与 `cov(x, y)` 是同一件事）。 */
  'cor', 'cov', 'quantile', 'zapsmall',
  /* 数格子、问缺失、插一段、换几格 —— 后两格与 `x[k] <- v` 同一套口径（见 `r_replace`）。 */
  'tabulate', 'anyNA', 'append', 'replace',
  /* 集合与位置那一族（见 `setFnDecl`）。`%in%` 是个算子，不在这张表里。 */
  'which.max', 'which.min', 'match', 'unique', 'duplicated',
  'union', 'intersect', 'setdiff', 'order', 'cumprod', 'cummax', 'cummin', 'anyDuplicated',
  'is.element', 'setequal', 'findInterval', 'median', 'rank',
  /* 位运算那一族（只接标量，见 `r_bit_v` 那段 32 位的账）。 */
  'bitwAnd', 'bitwOr', 'bitwXor', 'bitwNot', 'bitwShiftL', 'bitwShiftR',
  /* 串那一族。`tolower` 方言里没有算子（只有 `(supper …)`），由 `r_lower` 拿两张字母表
     查出来 —— **只管 ASCII**（见 SPEC 第四节第 12 条）。 */
  'toupper', 'tolower', 'substr', 'substring', 'trimws', 'sprintf', 'startsWith', 'endsWith',
  /* `casefold` 是那两格的别名（S 兼容）；`strrep` 是方言的 `(srep …)`。 */
  'casefold', 'strrep', 'chartr', 'format',
  /* 环境变量与"这是个函数吗"—— 后者在这一档是编译期常量（名字表里查得到就是）。 */
  'Sys.getenv', 'is.function',
  /* `strsplit` 只接两种形状（见 `splitOf`）：`strsplit(s, sep)[[1]]` 与
     `unlist(strsplit(s, sep))` —— R 那边它回的是一张**表**，而这一层没有"表里装向量"。 */
  'strsplit', 'unlist',
  /* 找与换那一族（见 `findOf`）—— **只认按字面找**那一档，pattern 是串字面量。 */
  'grepl', 'grep', 'sub', 'gsub',
  /* 函数当实参那一族 —— **只接就地写的匿名函数**（见 `applyOf`）。 */
  'sapply', 'vapply', 'lapply', 'Reduce', 'Filter', 'mapply',
  /* "这是什么东西"那三问 —— 类型在这一层是**推出来的**，所以答案是编译期常量。 */
  'is.character', 'is.numeric', 'is.logical',
  /* 停下来那一档（落方言的 `(fail …)`，只能摆在语句位上）。 */
  'stop', 'stopifnot',
  /* 分支那一格（落成一条 if 链，见 `switchOf`）。 */
  'switch',
  /* 造一条"空的/零的"向量：`numeric(n)` 那一族与不带实参的 `c()`。`character(n)` 是字符向量。 */
  'numeric', 'double', 'integer', 'logical', 'character',
  /* 名字那一族（见 `RNVEC`）：`names(v)` 读、`names(v) <- ns` 写、`setNames` / `unname`。 */
  'names', 'setNames', 'unname',
  /* 随机数那一族（发生器是 R 自己那一条，见 `RRAND`）。 */
  'set.seed', 'sample', ...RRAND.keys(),
  /* libm 那一族：R 自己这几个也是直接调 libm（不在 nmath 里），所以落方言的 `rmath`。
     一格实参、回 double —— `log(x, base)` 那种两格的**当场报**（R 那一档是 `log(x)/log(b)`，
     而"替它算"与"照它算"是两件事）。 */
  'sqrt', 'exp', 'log', 'log2', 'log10', 'floor', 'ceiling',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
]);

/** R 的名字 → `rmath` 那一格的名字（多半同名，`ceiling` 与 `log2`/`log10` 不同）。 */
const LIBM = new Map([
  ['sqrt', 'sqrt'], ['exp', 'exp'], ['log', 'log'], ['log2', 'log2'], ['log10', 'log10'],
  ['floor', 'floor'], ['ceiling', 'ceil'],
  ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'],
  ['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan'],
  ['sinh', 'sinh'], ['cosh', 'cosh'], ['tanh', 'tanh'],
]);

/* ─── 扫一段：哪些名字被写过、写进去的是什么 ────────────────────────────── */

/** `<-` / `<<-` / `:=` / `=` 都是赋值（前三个是 LEFT_ASSIGN，第四个是 EQ_ASSIGN）。 */
const ASSIGN_OPS = new Set(['<-', '<<-', ':=', '=']);
const isAssign = (x) => (tag(x) === 'bin' && ASSIGN_OPS.has(String(leaf(kids(x)[0]))))
  || tag(x) === 'bin-rev';

/** 一格赋值 → `{target, value}`（`->` / `->>` 那两格实参是反的，见 gram.y:498）。 */
function assignParts(x) {
  const [o, a, b] = kids(x);
  const op = tag(x) === 'bin-rev' ? String(leaf(o)) : String(leaf(o));
  return tag(x) === 'bin-rev'
    ? { target: b, value: a, op }
    : { target: a, value: b, op };
}

/** 走遍一棵子树，每格赋值回调一次。 */
function eachAssign(x, fn) {
  if (!isList(x)) return;
  if (isAssign(x)) fn(assignParts(x));
  for (const k of kids(x)) eachAssign(k, fn);
}

/** 这一格是不是 `list(…)` 那一次调用（有名字的表从它造出来）。 */
const isListCall = (node) => isList(node) && tag(node) === 'call'
  && tag(kids(node)[0]) === 'sym' && nameOf(kids(node)[0]) === 'list';

/**
 * 这一格表达式的**名字**那一条（回一格 `(arr string)` 的表达式，没有名字就回 `null`）。
 *
 * 只认这几种形状 —— 它们正好是名字**能跟住**的那几处：
 *   `c(a = 1, b = 2)`      名字是字面量（没给名字的那几格是空串，与 R 一样）
 *   `setNames(v, ns)`      名字就是第二格实参
 *   一个带名字的变量        名字在它的影子变量里（`v__nm`）
 *   `(…)`                  往里看
 *   `v * 2` 那种逐元素      名字跟着带名字的那一边走（R 也是这么传的）
 */
function namesExprOf(x, types) {
  if (!isList(x)) return null;
  if (tag(x) === 'paren') return namesExprOf(kids(x)[0], types);
  if (tag(x) === 'sym') {
    const nm = mangle(nameOf(x));
    const t = types.get(nm) ?? globalTys.get(nm);
    return isNamedTy(t) ? { kind: 'name', name: nmVar(nm) } : null;
  }
  if (tag(x) === 'bin') {
    const op = String(leaf(kids(x)[0]));
    if (!VEC_OPS.has(op)) return null;
    return namesExprOf(kids(x)[1], types) ?? namesExprOf(kids(x)[2], types);
  }
  if (tag(x) !== 'call' || tag(kids(x)[0]) !== 'sym') return null;
  const fn = nameOf(kids(x)[0]);
  if (fn === 'c') {
    const as = argsOf(x);
    if (!as.some((a) => a.name !== null)) return null;
    const tmp = fresh('nm');
    const tv = { kind: 'name', name: tmp };
    const stmts = [{
      kind: 'let', name: tmp, type: RSTRV, init: call1('anew', tyArg(RSTRV), { kind: 'int', value: as.length }),
    }];
    as.forEach((a, i) => stmts.push({
      kind: 'assign',
      target: { kind: 'index', obj: tv, index: { kind: 'int', value: i } },
      value: { kind: 'string', value: a.name ?? '' },
    }));
    return { kind: 'block-expr', stmts, value: tv };
  }
  if (fn === 'setNames') {
    const as = posArgs(x);
    if (as.length !== 2) throw new Error(`r->IR: setNames() 要两格实参（给了 ${as.length}）`);
    if (!isStrVec(typeOfExpr(as[1], types))) {
      throw new Error('r->IR: setNames() 的第二格实参要是一条字符向量');
    }
    return exprOf(as[1], types);
  }
  return null;
}

/** `m$k` 里那个键（右边是名字或串字面量 —— R 两种都收）。 */
const isDollar = (node) => isList(node) && tag(node) === 'bin'
  && String(leaf(kids(node)[0])) === '$';
function dollarKey(node) {
  const k = kids(node)[2];
  if (tag(k) === 'sym') return nameOf(k);
  if (tag(k) === 'str') return String(leaf(kids(k)[0]));
  throw new Error('r->IR: `$` 右边只接名字或串字面量');
}

/**
 * 用 `[[…]]` 读写过的名字，**加上"被 `list(…)` 赋过"的那些** —— R 的 `list` 这么用就是
 * 关联表（见文件头第 5 条）。
 *
 * 为什么 `list(…)` 那一半也要算进来：`cfg <- list(n = 10, tol = 1e-8)` 之后**只读不写**
 * （`cfg[["n"]]`）的那种写法里，`[[` 只出现在读的一侧 —— 光看 `[[` 也找得到它；但
 * `m <- list(a = 1); length(m)` 那种一次 `[[` 都没有的，从前推不出它是一张表（落成 int，
 * 然后在 `dnew` 那一步报"'m' 是 int"）。
 *
 * 反过来要**摘出去**一批：`v <- c(a = 1, b = 2)` 之后的 `v[["a"]]` 是**带名字的向量上
 * 按名字取**（见 `RNVEC`），不是表。这一格只能按形状分 —— 被 `c(…)` / `setNames(…)`
 * 赋过的名字就是向量，不是表。
 */
const VEC_MAKERS = new Set(['c', 'setNames', 'unname', 'numeric', 'double', 'integer', 'logical']);
const isVecMakerCall = (node) => isList(node) && tag(node) === 'call'
  && tag(kids(node)[0]) === 'sym' && VEC_MAKERS.has(nameOf(kids(node)[0]));

function dictNames(x, out = new Set(), vecs = new Set()) {
  if (!isList(x)) return out;
  if (tag(x) === 'sub2' && tag(kids(x)[0]) === 'sym') out.add(nameOf(kids(x)[0]));
  /* `m$k` 与 `m[["k"]]` 是同一件事（R 里 `$` 就是按名字取），所以这一格也算。 */
  if (isDollar(x) && tag(kids(x)[1]) === 'sym') out.add(nameOf(kids(x)[1]));
  if (isAssign(x)) {
    const { target, value } = assignParts(x);
    if (tag(target) === 'sym' && isListCall(value)) out.add(nameOf(target));
    if (tag(target) === 'sym' && isVecMakerCall(value)) vecs.add(nameOf(target));
  }
  for (const k of kids(x)) dictNames(k, out, vecs);
  for (const nv of vecs) out.delete(nv);
  return out;
}

/* ─── 类型推断 ─────────────────────────────────────────────────────────── */

/** 两格数值类型合起来：有一格是 real 就是 real（`1 + 0.5`）。 */
const joinNum = (a, b) => (a.kind === 'real' || b.kind === 'real' ? REAL : INT);

/**
 * 这一格下标是不是**写着一个负号**（`x[-1]` / `x[-i]` / `x[-c(1,3)]`）。
 *
 * R 的负下标是"把那几格丢掉"，所以 `x[-1]` 出来的是一条**向量**，不是一格数 ——
 * 类型上要分得开，而那只能看树（`x[k]` 里 k 运行期才知道正负，那一格照旧按位置取，
 * 越界时方言当场报）。`x[-c(1,3)]` 的下标本来就是向量，走 `r_vec_pick` 里那三条规矩。
 */
const isNegSub = (k) => isList(k) && tag(k) === 'un' && String(leaf(kids(k)[0])) === '-';

/** 一格表达式装的是什么。`types` 是这一段边推边查的那张表。 */
function typeOfExpr(x, types) {
  switch (tag(x)) {
    case 'num': {
      const txt = String(leaf(kids(x)[0]));
      const v = numLit(txt);
      if (v.kind === 'bool') return BOOL;
      /* **裸 `NA` 在 R 里是逻辑的**（`typeof(NA)` 是 "logical"）—— 所以
         `c(TRUE, FALSE, NA)` 是逻辑向量、印 `TRUE FALSE NA`。`NA_real_` 才是 double。 */
      if (txt === 'NA') return RLGL1;
      /* `NA_real_` 走生成出来的 `r_na()`、`NaN` / `Inf` 走 ccall —— 三格回的都是 double */
      return v.kind === 'real' || v.kind === 'ccall' || v.kind === 'call' ? REAL : INT;
    }
    case 'str': return STR;
    case 'paren': return typeOfExpr(kids(x)[0], types);
    case 'sym': {
      const nm = mangle(nameOf(x));
      const t = types.get(nm);
      if (t !== undefined) return t;
      /* 局部没有 → 看顶层那些模块级变量（R 的函数看得见顶层的名字，见 `globalTys`）。 */
      const g = globalTys.get(nm);
      if (g !== undefined) return g;
      return baseVar(nm) !== undefined ? baseVar(nm).type : INT;
    }
    case 'block': {
      const ks = kids(x);
      return ks.length === 0 ? INT : typeOfExpr(ks[ks.length - 1], types);
    }
    case 'if': {
      const ks = kids(x);
      return typeOfExpr(ks[1], types);
    }
    case 'un': {
      const op = String(leaf(kids(x)[0]));
      if (op !== '!') return typeOfExpr(kids(x)[1], types);
      /* `!` 跟着被取反的那一格走：逻辑向量进逻辑向量出，三态标量进三态标量出，
         `bool` 那一格（`!TRUE`）仍然是 `bool`。 */
      const t = typeOfExpr(kids(x)[1], types);
      if (isVecTy(t)) return isNamedTy(t) ? RNLGL : RLGL;
      return t.kind === 'real' ? RLGL1 : BOOL;
    }
    case 'sub1': {
      /* **被下标的那一格不一定是名字**：`sort(z)[250]` / `c(1,2)[1]` 都是常见写法，
         所以这儿问的是"那个表达式的类型"，不是"那个名字装什么"（`indexRead` 也是这么问的）。 */
      const a = typeOfExpr(kids(x)[0], types);
      /* 字符向量：取一格出来是一格串，按向量挑出来的还是一条字符向量。
         负下标（`s[-2]`）是"丢掉那一格"，出来的还是一条字符向量。 */
      if (isStrVec(a)) {
        const ks0 = kids(x).slice(1).map((k) => kids(k)[0]).filter((k) => k !== undefined);
        if (ks0.length === 1 && (isVecTy(typeOfExpr(ks0[0], types)) || isNegSub(ks0[0]))) return a;
        return STR;
      }
      if (!isVecTy(a)) return INT;
      /* 下标是向量 → 挑出来的还是一格向量（逻辑/数值随被挑的那个走）。
         **写着负号的那一格也是**（`x[-1]` 在 R 里是"丢掉第一格"，出来是一条向量）。 */
      const ks = kids(x).slice(1).map((k) => kids(k)[0]).filter((k) => k !== undefined);
      if (ks.length === 1 && (isVecTy(typeOfExpr(ks[0], types)) || isNegSub(ks[0]))) return a;
      /* 一格标量下标：**元素类型跟着向量走** —— 逻辑向量里取一格出来还是逻辑
         （`zs[1]` 印 `TRUE` 而不是 `1`）。 */
      return isLglTy(a) ? RLGL1 : REAL;
    }
    case 'sub2': {
      /* `strsplit(s, sep)[[1]]` —— 那一格是一条字符向量（见 `splitOf`）。 */
      if (isSplitCall(kids(x)[0])) return RSTRV;
      const d = typeOfExpr(kids(x)[0], types);
      if (d !== undefined && d.kind === 'map') return d.value;
      if (isVecTy(d)) return REAL;
      return INT;
    }
    case 'bin': {
      const op = String(leaf(kids(x)[0]));
      /* `m$k` —— 表上按名字取（那张表的值类型就是它的类型）。 */
      if (op === '$') {
        const d = typeOfExpr(kids(x)[1], types);
        return d !== undefined && d.kind === 'map' ? d.value : INT;
      }
      /* `%in%`：左边是向量就逐元素出逻辑向量，左边一格数就出三态标量。 */
      if (op === '%in%') {
        const lt3 = typeOfExpr(kids(x)[1], types);
        /* 串那一侧：字符向量进 → 逻辑向量，一格串进 → 一格 bool（`r_in1_str` 回 bool，
           不是三态 —— 串这一侧没有 `NA`）。 */
        if (isStrVec(lt3)) return RLGL;
        if (lt3.kind === 'string') return BOOL;
        return isVecTy(lt3) ? RLGL : RLGL1;
      }
      /* **向量那一问要摆在最前**：`xs > 2` 回的是**逻辑向量**，不是一格布尔 ——
         摆在 `return BOOL` 后面的话永远到不了（`sum(xs > 2)` 就会说"实参不是向量"）。 */
      if (VEC_OPS.has(op)) {
        const a = typeOfExpr(kids(x)[1], types);
        const c2 = typeOfExpr(kids(x)[2], types);
        if (isVecTy(a) || isVecTy(c2)) {
          const named = isNamedTy(a) || isNamedTy(c2);
          /* **名字跟着带名字的那一边走**（R 也是这么传的）：`v * 2` 还是带名字的、
             `v > 1` 是一条带名字的逻辑向量。 */
          if (VEC_CMP.has(op) || LGL_OPS.has(op)) return named ? RNLGL : RLGL;
          return named ? RNVEC : RVEC;
        }
      }
      /* 比较：有一边是 double（含三态逻辑本身）就回**三态逻辑**（`NaN > 2` 是 `NA`）。
         两边都是 int / bool 才回 `bool` —— 那一格没有 NA，见 `RLGL1` 那段账。 */
      if (CMP_FNS.has(op)) {
        const a = typeOfExpr(kids(x)[1], types);
        const c2 = typeOfExpr(kids(x)[2], types);
        if (a.kind === 'string' || c2.kind === 'string') return BOOL;
        return a.kind === 'real' || c2.kind === 'real' ? RLGL1 : BOOL;
      }
      /* `&` / `&&` / `|` / `||`：任一边是三态就三态（`TRUE && NA` 是 `NA`）。 */
      if (LGL_OPS.has(op) || op === '&&' || op === '||') {
        const a = typeOfExpr(kids(x)[1], types);
        const c2 = typeOfExpr(kids(x)[2], types);
        return a.kind === 'real' || c2.kind === 'real' ? RLGL1 : BOOL;
      }
      if (ASSIGN_OPS.has(op)) return typeOfExpr(kids(x)[2], types);
      if (op === ':') return RIVEC;
      /* `/` 一律实数除；`^` 走 `R_pow`、`%%` / `%/%` 走那条 floor 的算法 —— 三者都回 double */
      if (op === '/' || op === '^' || op === '**' || op === '%%' || op === '%/%') return REAL;
      return joinNum(typeOfExpr(kids(x)[1], types), typeOfExpr(kids(x)[2], types));
    }
    case 'bin-rev': return typeOfExpr(kids(x)[1], types);
    case 'call': return typeOfCall(x, types);
    default: return INT;
  }
}

/**
 * `sapply` / `lapply` / `vapply` / `Reduce` / `Filter` 回什么 —— 与 `applyOf` 摊开时
 * 用的是同一条推法：形参按"元素装什么"绑上，再问一遍函数体。
 */
function applyTy(fn, x, types) {
  const args = posArgs(x);
  const fnFirst = fn === 'Reduce' || fn === 'Filter' || fn === 'mapply';
  const fnode = fnFirst ? args[0] : args[1];
  const data = fnFirst ? args[1] : args[0];
  if (fnode === undefined || data === undefined || !isList(fnode) || tag(fnode) !== 'fn') return INT;
  const dt = typeOfExpr(data, types);
  const strIn = isStrVec(dt);
  const child = new Map(types);
  for (const p of formalsOf(fnode)) child.set(p, strIn ? STR : REAL);
  const bt = typeOfExpr(kids(fnode)[1], child);
  if (fn === 'Filter') return strIn ? RSTRV : dt;
  if (fn === 'Reduce') return bt.kind === 'string' ? STR : REAL;
  /* `mapply` 的形参两格都是 double（字符向量那一侧没接 —— R 会加名字），
     所以上头那趟按 `strIn` 绑的类型对它不适用；回的种类还是看函数体。 */
  if (fn === 'mapply') {
    const c2 = new Map(types);
    for (const p of formalsOf(fnode)) c2.set(p, REAL);
    const b2 = typeOfExpr(kids(fnode)[1], c2);
    return (b2.kind === 'bool' || isLgl1(b2)) ? RLGL : RVEC;
  }
  if (bt.kind === 'string') return RSTRV;
  if (bt.kind === 'bool' || isLgl1(bt)) return RLGL;
  return RVEC;
}

/** 一次调用的结果类型。内建各自说，用户函数按"这门语言的数"算（见文件头第 4 条）。 */function typeOfCall(x, types) {
  const fn = tag(kids(x)[0]) === 'sym' ? nameOf(kids(x)[0]) : null;
  const args = argsOf(x).map((a) => a.value).filter((v) => v !== null);
  /* R 自己的 C 那一族回的都是 `double` —— 这是 nmath 的形状，不是我们的选择。
     第一格实参是向量时逐元素，于是回的是一格向量（`sqrt(xs)` / `round(xs, 1)`）。 */
  if (fn !== null && RMATH.has(fn)) {
    /* `pmax` / `pmin` 在 R 里是**逐元素两头回收**的，不是"只在第一格上逐元素" ——
       有一边是向量就走生成出来的那格（见 `setFnDecl`）。 */
    if (fn === 'pmax' || fn === 'pmin') {
      return args.length >= 1 && args.some((a) => isVecTy(typeOfExpr(a, types))) ? RVEC : REAL;
    }
    return args.length > 0 && isVecTy(typeOfExpr(args[0], types)) ? RVEC : REAL;
  }
  /* `r*` 那一族出的是**长度 n 的向量**（R 里 `rnorm(1)` 也是一格长度 1 的向量）。 */
  if (fn !== null && RRAND.has(fn)) return RVEC;
  if (fn !== null && PRED.has(fn)) return BOOL;
  if (fn === 'is.na' || fn === 'is.nan') return BOOL;
  switch (fn) {
    /* `paste(v, collapse=s)` 把一条向量连成**一格串**；不给 `collapse` 而有向量参与时
       逐元素出一条**字符向量**（`paste0("#", 1:3)`）。 */
    case 'paste': case 'paste0': {
      if (namedArg(x, 'collapse') !== undefined) return STR;
      return args.some((a) => {
        const t = typeOfExpr(a, types);
        return isVecTy(t) || isStrVec(t);
      }) ? RSTRV : STR;
    }
    /* `as.character` 在向量上出一条**字符向量**（见 `callOf` 里那段 NA 的账）。 */
    case 'as.character': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : STR;
      return isVecTy(t) ? RSTRV : STR;
    }
    case 'sprintf': {
      /* 有一格实参是向量 → 出一整条字符向量（见 `sprintfOf` 里那段账）。 */
      const ps = posArgs(x).slice(1);
      return ps.some((a) => {
        const t = typeOfExpr(a, types);
        return isVecTy(t) || isStrVec(t);
      }) ? RSTRV : STR;
    }
    /* 串那一族在字符向量上逐元素（出来还是一条字符向量 / 逻辑向量）。 */
    case 'substr': case 'substring': case 'trimws': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : STR;
      return isStrVec(t) ? RSTRV : STR;
    }
    /* `strsplit(…)[[1]]` 在 `sub2` 那一格答；`unlist(strsplit(…))` 与它同解。 */
    case 'unlist': {
      if (args.length !== 1) return INT;
      if (isSplitCall(args[0])) return RSTRV;
      if (isApplyCall(args[0], 'lapply')) return applyTy('lapply', args[0], types);
      return INT;
    }
    case 'sapply': case 'vapply': case 'lapply': case 'Reduce': case 'Filter': case 'mapply':
      return applyTy(fn, x, types);
    case 'strsplit': return RSTRV;
    /* 找与换那一族（见 `findOf`）：`grepl` 的形状随被找的那一格、`grep` 回位置（或元素）、
       `sub` / `gsub` 逐元素换（一格串进一格串出）。 */
    case 'grepl': {
      const ps = posArgs(x);
      return ps.length > 1 && isStrVec(typeOfExpr(ps[1], types)) ? RLGL : BOOL;
    }
    case 'grep': return namedArg(x, 'value') !== undefined ? RSTRV : RIVEC;
    case 'sub': case 'gsub': {
      const ps = posArgs(x);
      return ps.length > 2 && isStrVec(typeOfExpr(ps[2], types)) ? RSTRV : STR;
    }
    case 'is.character': case 'is.numeric': case 'is.logical': return BOOL;
    case 'toupper': return args.length > 0 && isStrVec(typeOfExpr(args[0], types)) ? RSTRV : STR;
    case 'startsWith': case 'endsWith': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : STR;
      return isStrVec(t) ? RLGL : BOOL;
    }
    case 'length': return INT;
    /* `as.numeric` / `as.integer` 的形状跟着进去的那一格走（向量进向量出，见 `callOf`）。 */
    case 'as.integer': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : INT;
      return isVecTy(t) ? RIVEC : INT;
    }
    /* `nchar` / `tolower` / `toupper` 逐元素：字符向量进 → 出另一条向量。 */
    case 'nchar': return args.length > 0 && isStrVec(typeOfExpr(args[0], types)) ? RIVEC : INT;
    case 'tolower': return args.length > 0 && isStrVec(typeOfExpr(args[0], types)) ? RSTRV : STR;
    /* `casefold` 是 `toupper` / `tolower` 的别名（S 兼容），`strrep` 逐元素接起来。 */
    case 'casefold': case 'strrep':
      return args.length > 0 && isStrVec(typeOfExpr(args[0], types)) ? RSTRV : STR;
    /* `format()` 这一档只接标量 —— 回一格串（向量那一侧见 `callOf` 里那段账）。 */
    case 'format': return STR;
    /* `Sys.getenv(名字)` 回一格串；`is.function` 回编译期算出来的真假。 */
    case 'Sys.getenv': return STR;
    case 'is.function': return BOOL;
    /* `chartr(old, new, x)` 的形状跟着**第三格**走（前两格是字符表）。 */
    case 'chartr':
      return args.length > 2 && isStrVec(typeOfExpr(args[2], types)) ? RSTRV : STR;
    /* `character(n)` —— 一条 n 格空串的字符向量。 */
    case 'character': return RSTRV;
    case 'as.numeric': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : REAL;
      return isVecTy(t) ? RVEC : REAL;
    }
    case 'is.null': return BOOL;
    case 'sum': case 'mean': case 'max': case 'min': return REAL;
    /* `any` / `all` 回的是**带 NA 的标量逻辑**（`any(c(FALSE, NA))` 是 `NA`）。 */
    case 'any': case 'all': return RLGL1;
    /* `xor` 逐元素；`isTRUE` / `isFALSE` 回两态；`ifelse` 的形状随 test。 */
    case 'xor': return args.some((a) => isVecTy(typeOfExpr(a, types))) ? RLGL : RLGL1;
    case 'isTRUE': case 'isFALSE': return BOOL;
    case 'ifelse': {
      const sArgs = posArgs(x);
      /* 两支是串 → 出字符向量（test 是向量）或者一格串（test 是标量）。 */
      if (sArgs.length === 3 && [1, 2].some((k) => typeOfExpr(sArgs[k], types).kind === 'string')) {
        return isVecTy(typeOfExpr(sArgs[0], types)) ? RSTRV : STR;
      }
      const lgl = args.length === 3
        && [1, 2].every((k) => {
          const t = typeOfExpr(args[k], types);
          return t.kind === 'bool' || isLgl1(t) || isLglTy(t);
        });
      if (args.length > 0 && isVecTy(typeOfExpr(args[0], types))) return lgl ? RLGL : RVEC;
      return lgl ? RLGL1 : REAL;
    }
    /* 这三格进出都是向量（`which` 回的是位置，所以是数值向量，不是逻辑向量）。
       `rev` 的元素类型跟着进去的那条走（字符向量倒过来还是字符向量）。 */
    case 'rev': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : RVEC;
      if (isStrVec(t)) return RSTRV;
      return isVecTy(t) ? t : RVEC;
    }
    case 'seq_along': case 'which': case 'seq_len': return RIVEC;
    /* `sort` / `head` / `tail` / `rep` 出来的**元素类型跟着进去的那条走**
       （逻辑向量排完还是逻辑、整数向量排完还是整数）；`range` / `seq` 一律数值，
       而 `cumsum` / `diff` 在 R 里**整数进整数出**（零长时印 `integer(0)`）。 */
    case 'sort': case 'head': case 'tail': case 'rep': case 'rep_len': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : RVEC;
      /* `rep` 在串上也接了（`rep("ab", 3)` 出一条字符向量）。 */
      if (isStrVec(t) || (fn === 'rep' && t.kind === 'string')) return RSTRV;
      return isVecTy(t) ? t : RVEC;
    }
    case 'cumsum': case 'diff': case 'cumprod': case 'cummax': case 'cummin': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : RVEC;
      return isIvecTy(t) ? RIVEC : RVEC;
    }
    /* `tabulate` 数的是"几次"，所以回**整数向量**（零长印 `integer(0)`）；
       `anyNA` 回一格真假（它自己从不回 `NA`，所以是 bool 而不是三态的 `RLGL1`）。
       `append` / `replace` 出来的元素类型跟着第一格进去的那条走。 */
    case 'tabulate': return RIVEC;
    case 'anyNA': return BOOL;
    /* `is.element(el, set)` 就是 `el %in% set`，所以类型跟那一格同一条：左边是向量
       出逻辑向量、左边一格数出三态标量。`setequal` 回一格真假、`findInterval` 回位置
       （整数向量）、`median` 回一格数。 */
    case 'is.element': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : REAL;
      return isVecTy(t) ? RLGL : RLGL1;
    }
    case 'setequal': return BOOL;
    case 'findInterval': return RIVEC;
    case 'median': return REAL;
    /* `cor` / `cov` 回一格数（两条向量进）。 */
    case 'cor': case 'cov': return REAL;
    /* `quantile` 回一条数值向量（`names = FALSE` 那一档 —— 见 `callOf`）。 */
    case 'quantile': return RVEC;
    /* `zapsmall` 进出都是数值向量。 */
    case 'zapsmall': return RVEC;
    /* `rank` 并列取平均 —— 出来的可能带小数（`rank(c(2,2,1))` 是 `2.5 2.5 1.0`），
       所以一律数值向量，不跟着进去那条是不是整数走。 */
    case 'rank': return RVEC;
    /* 位运算那一族回一格 32 位整数（出了 32 位就当场报，见 `r_bit_v`）。 */
    case 'bitwAnd': case 'bitwOr': case 'bitwXor': case 'bitwNot':
    case 'bitwShiftL': case 'bitwShiftR': return INT;
    case 'append': case 'replace': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : RVEC;
      return isVecTy(t) ? t : RVEC;
    }
    case 'range': case 'seq': return RVEC;
    /* 集合与位置那一族：位置回一格 int，别的回向量（`duplicated` 回逻辑向量）。
       `match` / `order` 回的是**位置**，所以是整数向量；三格集合运算跟着进去的那条走。 */
    case 'which.max': case 'which.min': return INT;
    /* `anyDuplicated` 回的是**位置**（没有就 0）—— 一格 int。 */
    case 'anyDuplicated': return INT;
    case 'match': case 'order': return RIVEC;
    case 'unique': case 'union': case 'intersect': case 'setdiff': {
      const t = args.length > 0 ? typeOfExpr(args[0], types) : RVEC;
      /* 串那一侧出的还是字符向量（只用"相等"那一族，见 `callOf`）。 */
      if (isStrVec(t) || t.kind === 'string') return RSTRV;
      return isIvecTy(t) ? RIVEC : RVEC;
    }
    case 'duplicated': return RLGL;
    /* `numeric(n)` 那一族：出一条零向量（`logical(n)` 是一条 FALSE 的逻辑向量）。
       `integer(n)` 的零长印 `integer(0)` —— 元素类型不一样。 */
    case 'numeric': case 'double': return RVEC;
    case 'integer': return RIVEC;
    case 'logical': return RLGL;
    /* 随机数那一族：R 的 `runif(n, …)` 出的是**长度 n 的向量**（`runif(1)` 也是向量）。
       `sample` 抽的是位置，回整数向量。 */
    case 'sample': return RIVEC;
    case 'set.seed': return { kind: 'void' };
    case 'stop': case 'stopifnot': return { kind: 'void' };
    /* `switch` 回的是被选中那一支的类型（各支不同种在这一档是错的，量的是第一支）。 */
    case 'switch': {
      const arms = argsOf(x).slice(1).filter((a) => a.value !== null);
      return arms.length === 0 ? INT : typeOfExpr(arms[0].value, types);
    }
    case 'prod': case 'var': case 'sd': return REAL;
    /* 这一批第一格是向量就逐元素（`sqrt(xs)`），标量进标量出。 */
    case 'sqrt': case 'exp': case 'log': case 'log2': case 'log10':
    case 'floor': case 'ceiling':
    case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan':
    case 'sinh': case 'cosh': case 'tanh':
      return args.length > 0 && isVecTy(typeOfExpr(args[0], types)) ? RVEC : REAL;
    case 'abs': return args.length === 0 ? INT : typeOfExpr(args[0], types);
    /* `invisible(x)` 的类型就是 x 的（差别只在顶层要不要印）。 */
    case 'invisible': return args.length === 0 ? INT : typeOfExpr(args[0], types);
    case 'return': return args.length === 0 ? INT : typeOfExpr(args[0], types);
    /* `c(TRUE, FALSE)` 在 R 里是**逻辑**向量（印 `TRUE` / `FALSE`），`c(1, 2)` 是数值向量。
       混着写（`c(TRUE, 1)`）R 会往数值那边收，所以"每一格都是逻辑"才算逻辑。
       **有一格是串就整条是字符向量** —— R 的收拢次序是 logical < integer < double < character。 */
    case 'c': {
      /* **`c` 的命名实参是元素名，不是开关** —— 所以这儿按 `argsOf` 的**原序**看全部实参
         （`posArgs` 会把 `c(a = 1, b = 2)` 过滤成空的）。 */
      const cargs = argsOf(x).map((a) => a.value);
      if (cargs.some((a) => {
        const t = typeOfExpr(a, types);
        return t.kind === 'string' || isStrVec(t);
      })) return RSTRV;
      if (cargs.length > 0 && cargs.every((a) => {
        const t = typeOfExpr(a, types);
        return t.kind === 'bool' || isLgl1(t) || isLglTy(t);
      })) return RLGL;
      /* `c(a = 1, b = 2)` —— 带名字的数值向量（名字那一条见 `namesExprOf`）。 */
      return argsOf(x).some((a) => a.name !== null) ? RNVEC : RVEC;
    }
    /* 名字那几格：`names(v)` 出一条字符向量、`setNames` 出带名字的向量、`unname` 把名字摘掉。 */
    case 'names': return RSTRV;
    case 'setNames': return RNVEC;
    /* `unname` 只摘名字，别的记号（逻辑 / 字符）留着。 */
    case 'unname': {
      const t0 = args.length === 0 ? RVEC : typeOfExpr(args[0], types);
      if (isStrVec(t0)) return t0;
      return isLglTy(t0) ? RLGL : RVEC;
    }
    /* `list(a = 1, b = 2)` —— R 的 list 当**关联表**用那一档（文件头第 5 条）。
       值类型按那几格实参算（有一格是串就整张表装串）。 */
    case 'list': {
      const vals = argsOf(x).filter((a) => a.name !== null).map((a) => a.value);
      if (vals.length === 0) return dictOf(INT);
      return dictOf(vals.some((v) => typeOfExpr(v, types).kind === 'string')
        ? STR
        : vals.map((v) => typeOfExpr(v, types)).reduce(joinNum, INT));
    }
    default: {
      /* 用户函数：`inferFns()` 扫调用点推出来的那张表（表外的名字才落 int）。
         回 void 的那些（体尾是 `cat(…)` 那种）在这儿也按 int 报 —— 它们只该出现在
         语句位上，而"顶层要不要自动印"那一问直接查 `fnRets`（见 `isAutoPrint`）。 */
      if (fn === null) return INT;
      const rt = fnRets.get(mangle(fn));
      return rt === undefined || rt.kind === 'void' ? INT : rt;
    }
  }
}

/**
 * 一段（函数体 / 顶层）里每个名字装什么。
 *
 * 次序要紧（与 `ext/awk/adapter.js` 同一条）：字典先定（它决定 `m[["k"]]` 的类型），
 * 再定别的。同一个名字写过多次而类型不同时**后写的赢** —— 例子里不出现，
 * 真出现了那是这门语言要单独定的一条规矩，不该在这儿悄悄挑一个。
 */
function inferTypes(body, params, seed) {
  const types = new Map();
  for (const p of params) types.set(p, seed?.get(p) ?? INT);
  const dicts = dictNames(body);
  for (const d of dicts) {
    const writes = [];
    eachAssign(body, ({ target, value }) => {
      if (tag(target) === 'sub2' && mangle(nameOf(kids(target)[0])) === mangle(d)) writes.push(value);
      if (isDollar(target) && tag(kids(target)[1]) === 'sym'
          && mangle(nameOf(kids(target)[1])) === mangle(d)) writes.push(value);
      /* `m <- list(a = 1, tol = 1e-8)` 里那几格也是"往这张表里写" —— 值类型要算它们，
         不然 `list(a = 1.5)` 会落成 `dict<string,int>`，`dset` 那一步当场报。 */
      if (tag(target) === 'sym' && mangle(nameOf(target)) === mangle(d) && isListCall(value)) {
        for (const a of argsOf(value)) if (a.name !== null) writes.push(a.value);
      }
    });
    const vt = writes.length === 0 ? INT
      : (writes.some((w) => typeOfExpr(w, types).kind === 'string') ? STR
        : writes.map((w) => typeOfExpr(w, types)).reduce(joinNum, INT));
    types.set(mangle(d), dictOf(vt));
  }
  /* **两遍**（转到不动点）。两边互相要对方：`for (x in xs)` 里 `x` 的类型要问 `xs`，
     而 `xs` 的类型来自一句赋值；反过来 `t <- t + x` 里 `t` 要问 `x`。
     一遍下来必有一头是空的（症状是降级那一层报"t 是 int、赋的值是 real"），
     所以扫两遍：第一遍定住那些不依赖循环量的名字，第二遍把循环量与跟着它的名字定住。 */
  for (let round = 0; round < 2; round++) inferRound(body, params, types);
  return types;
}

/**
 * **两格类型合起来取宽的那一个**（形参要装得下所有调用点传进来的东西）。
 *
 * 次序是 `int < real < 向量`，串与表自己一档。这不是"类型格"上的正经 join ——
 * R 里一个形参真的能一会儿收数、一会儿收串，那一层要运行期的类型标签（`SEXPTYPE`），
 * 这一档没有。所以规矩是：**两边对不上就留先来的那个**，而不是挑一个"兼容"的假答案。
 */
function widenTy(a, c) {
  if (a === undefined) return c;
  if (c === undefined) return a;
  /* 字符向量是自己一格（它不在 `int → real → 向量` 那条链上）：有一边是它就是它。
     真跟数值向量撞上了（同一个形参一会儿装串一会儿装数）留先来的那个 —— 那要运行期
     的类型标签，这一档没有（见 SPEC §4 第 5 条）。 */
  if (isStrVec(a)) return a;
  if (isStrVec(c)) return c;
  if (isVecTy(a)) return isLglTy(a) && !isLglTy(c) && isVecTy(c) ? c : a;
  if (isVecTy(c)) return c;
  if (a.kind === c.kind) return isLgl1(a) && !isLgl1(c) ? c : a;
  if (a.kind === 'string' || c.kind === 'string') return a.kind === 'string' ? a : c;
  if (a.kind === 'map' || c.kind === 'map') return a.kind === 'map' ? a : c;
  /* 剩下的是 int / real / bool 三格：real 最宽，bool 只在两边都是 bool 时留住 */
  if (a.kind === 'real' || c.kind === 'real') return REAL;
  if (a.kind === 'int' || c.kind === 'int') return INT;
  return a;
}

/** 走遍一棵子树，每一格"名字 + 实参"的调用回调一次。 */
function eachCall(x, fn) {
  if (!isList(x)) return;
  if (tag(x) === 'call' && tag(kids(x)[0]) === 'sym') fn(nameOf(kids(x)[0]), x);
  for (const k of kids(x)) eachCall(k, fn);
}

/**
 * **apply 那一族里那段匿名函数，它的形参装什么** —— 数据那一格决定（与 `applyOf` 里
 * 算 `elemTy` 是同一条：字符向量给串，别的给 double）。回的是几格"多出来的作用域"。
 *
 * 为什么不把它并进外层那张类型表：外层可能有个**同名**的变量（`x` 在顶层是串、在
 * `sapply(v, function(x) …)` 里是数），并进去会把外层那个带歪，而那张表还要喂
 * `globalTys`。多摆一个作用域就够了 —— `inferFns` 第 2 步只把形参类型**并宽**，
 * 外层那趟按 int 算出来的那一笔压不下这儿的 real。
 *
 * 量出来的那一格（2026-09-26）：`f <- function(x) x * 2;
 * sapply(c(1,2,3), function(x) f(x))` 从前报 `'f' 的第 1 个形参是 int，给的是 real`
 * —— 因为 `f(x)` 里那个 `x` 在外层那张表里查不到，落回 int。
 */
const APPLY_FNS = new Set(['sapply', 'vapply', 'lapply', 'Reduce', 'Filter', 'mapply']);
function applyScopes(body, types) {
  const out = [];
  eachCall(body, (name, node) => {
    if (!APPLY_FNS.has(String(name))) return;
    const as = posArgs(node);
    const fnFirst = name === 'Reduce' || name === 'Filter' || name === 'mapply';
    const fnode = fnFirst ? as[0] : as[1];
    const data = fnFirst ? as[1] : as[0];
    if (fnode === undefined || data === undefined) return;
    if (!isList(fnode) || tag(fnode) !== 'fn') return;
    const dt = typeOfExpr(data, types);
    const elem = isStrVec(dt) ? STR : REAL;
    const ps = formalsOf(fnode);
    const fb = kids(fnode)[1];
    out.push({ body: fb, types: inferTypes(fb, ps, new Map(ps.map((p) => [p, elem]))) });
  });
  return out;
}

/**
 * **apply 那一族里"给的是一个函数名字"那种写法**（`sapply(v, f)` / `Reduce(\`+\`, v)`）
 * —— 就地改写成匿名函数：`sapply(v, function(.omni.a0) f(.omni.a0))`。
 *
 * 为什么是改写而不是在 `applyOf` 里另开一条路：那一段（回收 / 字符向量 / `USE.NAMES`
 * 那几问）只该有**一份**实现 —— 与 `sprintf` 那一处"合成 CST 再递归下来"同一条办法。
 * 为什么摆在 `inferFns` **之前**：那一遍要靠 `f(.omni.a0)` 这个**调用点**才推得出
 * `f` 的形参装什么（这一档没有别的信息源）。
 *
 * 算子名（`` `+` `` 那种）合成的是 `bin` 节点，不是 `call` —— 方言里它们不是函数。
 */
const APPLY_OPS = new Set(['+', '-', '*', '/', '^', '%%', '%/%']);
const cstFnOf = (ps, body) => cstList(
  'fn', cstList('formals', ...ps.map((p) => cstList('formal', cstSym(p)))), body,
);
function nameToLambda(x, userFns) {
  if (!isList(x)) return;
  for (const k of kids(x)) nameToLambda(k, userFns);
  if (tag(x) !== 'call' || tag(kids(x)[0]) !== 'sym') return;
  const nm2 = String(nameOf(kids(x)[0]));
  /**
   * `do.call(f, list(…))` —— **就地摊成一次普通调用**（`do.call(sum, list(1,2))` → `sum(1,2)`）。
   *
   * 只认第二格是**就地写的 `list(…)`** 那一种：那时"有几格实参、哪一格带名字"都是
   * 编译期看得见的，摊开之后与 R 同解（量出来 `do.call(f, list(y=3, x=2))` 也对得上 ——
   * 命名实参那几格照原样搬过去，`bindArgs` 那一侧本来就会配）。
   * 第二格是一格**变量**的那种没接：那要运行期才知道长度与名字，当场报（在 `callOf` 那侧）。
   */
  if (nm2 === 'do.call') {
    const as = kids(x).slice(1).filter((a) => tag(a) === 'arg');
    if (as.length !== 2) return;
    const fnode = kids(as[0])[0];
    const lnode = kids(as[1])[0];
    if (fnode === undefined || lnode === undefined || !isList(fnode) || !isList(lnode)) return;
    if (tag(fnode) !== 'sym' && tag(fnode) !== 'str') return;
    if (tag(lnode) !== 'call' || tag(kids(lnode)[0]) !== 'sym' || String(nameOf(kids(lnode)[0])) !== 'list') return;
    const rname2 = String(nameOf(fnode));
    if (!BUILTINS.has(rname2) && !RMATH.has(rname2) && !userFns.has(mangle(rname2))) return;
    x.items = [{ kind: 'atom', value: 'call' }, cstSym(rname2), ...kids(lnode).slice(1)];
    return;
  }
  if (!APPLY_FNS.has(nm2)) return;
  const fnFirst = nm2 === 'Reduce' || nm2 === 'Filter' || nm2 === 'mapply';
  /* 要换的是第几格**位置**实参 —— 在 `items` 里数（`kids(x).slice(1)` 那一串）。 */
  const slots = kids(x).slice(1).filter((a) => tag(a) === 'arg');
  const slot = slots[fnFirst ? 0 : 1];
  if (slot === undefined) return;
  const fnode = kids(slot)[0];
  if (fnode === undefined || !isList(fnode) || tag(fnode) !== 'sym') return;
  const rname = String(nameOf(fnode));
  const nps = (nm2 === 'Reduce' || nm2 === 'mapply') ? 2 : 1;
  const ps = [...Array(nps)].map((_, k) => `.omni.a${k}`);
  let body;
  if (APPLY_OPS.has(rname)) {
    if (nps !== 2) return;
    body = cstList('bin', { kind: 'atom', value: rname }, cstSym(ps[0]), cstSym(ps[1]));
  } else if (BUILTINS.has(rname) || RMATH.has(rname) || userFns.has(mangle(rname))) {
    body = cstCall(rname, ps.map((p) => cstSym(p)));
  } else {
    /* 表外的名字不猜：`applyOf` 那一侧会报"要就地写成 `function(…) …`"。 */
    return;
  }
  slot.items[1] = cstFnOf(ps, body);
}

/**
 * **把用户函数的形参与返回类型推出来**（填 `fnParams` / `fnRets`）。
 *
 * 只有一处信息源：调用点。所以一轮是"按现在这份形参类型把每段的局部类型推一遍 →
 * 扫所有调用点、把实参类型并进形参 → 重算每个函数的返回类型"。
 *
 * 转**三轮**：一轮定住"顶层直接调的那些"，二轮定住"函数里调函数"，三轮让返回类型跟上
 * （`g` 的返回值当 `f` 的实参那种）。不动点在这一档一定存在 —— `widenTy` 只往宽走，
 * 而宽度是有限的（int → real → 向量）。
 */
function inferFns(fns, rest) {
  /* 默认值：形参那一格有第二个孩子就是它（`function(x, n = 10)` 的 `10`）。
     **不许引用这个函数自己的形参** —— 默认值是在调用点求的，那儿还没有那些名字。 */
  const defsOf = (node, ps) => kids(kids(node)[0]).map((f) => {
    const ks = kids(f);
    if (ks.length < 2 || ks[1] === undefined) return null;
    const bad = [];
    const walk = (y) => {
      if (!isList(y)) return;
      if (tag(y) === 'sym' && ps.includes(mangle(nameOf(y)))) bad.push(nameOf(y));
      for (const k of kids(y)) walk(k);
    };
    walk(ks[1]);
    if (bad.length > 0) {
      throw new Error(`r->IR: 形参默认值里引用了这个函数自己的形参（\`${bad[0]}\`）——`
        + ' 那要真的 promise（R 是在被调方求值的），这一档在调用点填默认值，那儿还没有这个名字');
    }
    return ks[1];
  });
  const mainBlock = { kind: 'list', items: [{ kind: 'atom', value: 'block' }, ...rest] };
  for (const f of fns) {
    const ps = formalsOf(f.node);
    if (!fnFormals.has(f.name)) fnFormals.set(f.name, ps);
    if (!fnDefs.has(f.name)) fnDefs.set(f.name, defsOf(f.node, ps));
    if (!fnParams.has(f.name)) fnParams.set(f.name, ps.map(() => INT));
    if (!fnRets.has(f.name)) fnRets.set(f.name, INT);
  }
  const byName = new Map(fns.map((f) => [f.name, f]));
  for (let round = 0; round < 3; round++) {
    /* 1) 每段按现在这份形参类型推一遍局部类型（顶层那段没有形参） */
    const scopes = [{ body: mainBlock, types: inferTypes(mainBlock, []) }];
    /* **顶层那些被函数用到的名字 → 模块级变量**（见 `globalTys` 那段账）。
       要在函数体的类型推断之前定住，不然 `memo[n]` 里的 `memo` 还是不知道装什么。
       每一轮都刷一遍：第一轮时顶层那份类型可能还没定型（它也要问函数回什么）。 */
    const used = new Set();
    for (const f of fns) for (const s of freeSyms(f.node)) used.add(s);
    for (const [n2, t2] of scopes[0].types) {
      if (used.has(n2) || globalTys.has(n2)) globalTys.set(n2, t2);
    }
    for (const f of fns) {
      const ps = formalsOf(f.node);
      const seed = new Map(ps.map((p, k) => [p, fnParams.get(f.name)[k]]));
      scopes.push({ body: kids(f.node)[1], types: inferTypes(kids(f.node)[1], ps, seed) });
    }
    /* apply 那一族里那几段匿名函数体也算作用域（见 `applyScopes` 上那段账）。 */
    for (const sc of [...scopes]) for (const s of applyScopes(sc.body, sc.types)) scopes.push(s);
    /* 2) 扫所有调用点，把实参类型并进形参（命名实参与默认值都按 `bindArgs` 配） */
    for (const sc of scopes) {
      eachCall(sc.body, (name, node) => {
        const target = byName.get(mangle(name));
        if (target === undefined) return;
        const cur = fnParams.get(target.name);
        const ps = fnFormals.get(target.name);
        let bound;
        try {
          bound = bindArgs(name, ps, fnDefs.get(target.name) ?? [], node, false);
        } catch {
          /* 配不上（少实参那种）在 `callOf` 那一侧会当场报，这一轮先跳过 */
          return;
        }
        bound.forEach((a, k) => {
          if (a === null || a === undefined || k >= cur.length) return;
          cur[k] = widenTy(cur[k], typeOfExpr(a, sc.types));
        });
      });
    }
    /* 3) 返回类型（要在形参定住之后算，所以摆在这一轮的末尾）。
          顺带**把形参类型跟着函数体改宽**：`revnum <- function(n) { n <- n %/% 10 }` 里
          那个 `n` 在体里被赋了 double，于是调用点那侧也得按 double 传（方言不隐式转）。 */
    for (const f of fns) {
      const ps = formalsOf(f.node);
      const seed = new Map(ps.map((p, k) => [p, fnParams.get(f.name)[k]]));
      const local = inferTypes(kids(f.node)[1], ps, seed);
      const cur = fnParams.get(f.name);
      ps.forEach((p, k) => { cur[k] = widenTy(cur[k], local.get(p)); });
      fnRets.set(f.name, returnType(kids(f.node)[1], local) ?? { kind: 'void' });
    }
  }
}

/** `inferTypes` 的一遍（见那边"两遍"的账）。 */function inferRound(body, params, types) {
  forNames(body, types);
  /* 同一个名字写过多次：**串赢、其次实数赢**（`t <- 0` 之后 `t <- t + 2.5`，t 是 double）。
     R 那边这不是"类型"而是"这一刻装着什么"，而方言那侧一个名字只有一种类型 ——
     所以取能装下所有写的那一种。 */
  const rank = (t) => (t.kind === 'string' ? 3 : (isVecTy(t) || t.kind === 'map' ? 3
    : (t.kind === 'real' ? 2 : 1)));
  eachAssign(body, ({ target, value, op }) => {
    /* `names(v) <- ns` —— 那一句把 `v` 变成**带名字的**向量（记号见 `RNVEC`）。
       `rank` 那条管不了这一格：两边都是"向量"，宽度一样，所以单独记一笔。 */
    if (tag(target) === 'call' && tag(kids(target)[0]) === 'sym'
        && nameOf(kids(target)[0]) === 'names') {
      const a0 = posArgs(target)[0];
      if (a0 !== undefined && tag(a0) === 'sym') {
        const nv = mangle(nameOf(a0));
        const t2 = types.get(nv);
        if (t2 !== undefined && isVecTy(t2) && !isLglTy(t2)) types.set(nv, RNVEC);
      }
      return;
    }
    if (tag(target) !== 'sym') return;
    const name = mangle(nameOf(target));
    /* `<<-` 写的是**全局**（R 的规矩）—— 那一格不该变成这一段的局部量。 */
    if (op === '<<-' && globalTys.has(name)) return;
    const t0 = typeOfExpr(value, types);
    const t = t0.kind === 'bool' ? INT : t0;        // 条件的值装进量里当 0/1
    const had = types.get(name);
    /* **形参也算**（只往宽走）：`revnum <- function(n) { n <- n %/% 10; … }` 里那个 `n`
       被赋了 double，于是它得是 double —— 调用点那侧由 `inferFns` 把形参类型跟着改宽。 */
    if (had === undefined || rank(t) > rank(had)) types.set(name, t);
  });
}

/** `for (v in seq)` 里那个 `v`：区间是 int，序列是它的元素类型。 */
function isRangeHead(seq) {
  return tag(seq) === 'bin' && String(leaf(kids(seq)[0])) === ':';
}

function forNames(x, types) {
  if (!isList(x)) return;
  if (tag(x) === 'for') {
    const fc = kids(x)[0];
    const v = mangle(nameOf(kids(fc)[0]));
    const seq = kids(fc)[1];
    /* `for (v in a:b)` 落成计数循环（见 `forOf`），循环量是 int —— 这一格要跟那边对齐，
       不能问 `typeOfExpr`（那边答的是"`a:b` 当值用时是一格向量"）。 */
    const st = isRangeHead(seq) ? INT : typeOfExpr(seq, types);
    /* 向量上遍历，循环量是一格 double；字符向量上遍历，循环量是一格串。 */
    const want = isStrVec(st) ? STR : (isVecTy(st) ? REAL : st);
    const had = types.get(v);
    /* **第二遍要能盖掉第一遍** —— 第一遍时那格序列可能还没定型（`for (x in xs)` 里的 `xs`
       是后面一句赋值定的），于是 `x` 先按 int 记下。只往"装得下"的方向走，不往回：
       int 是那个"还不知道"的起点，所以它让位给别的（double、串）；反过来不行。 */
    if (had === undefined || (had.kind === 'int' && want.kind !== 'int')) types.set(v, want);
  }
  for (const k of kids(x)) forNames(k, types);
}

/** 一段 `function(…) …` 的形参名（按序）。 */
const formalsOf = (node) => kids(kids(node)[0]).map((f) => mangle(nameOf(kids(f)[0])));

/**
 * 一段函数体里**自由的那些名字** —— 就是"函数里提到、但函数自己没有绑过"的名字。
 *
 * 这一问是给 `globalTys` 用的：顶层的名字只有被函数**自由**地用到，才要落成模块级变量。
 * 不能拿"函数体里出现过的所有符号"当答案 —— R 里 `for (i in 2:m)` 的 `i`、`out <- c()`
 * 的 `out` 都是**函数自己的局部量**，它们跟顶层那个同名的 `i` 没有关系。量到过：早先那版
 * 按"出现过"算，`ext/r/examples/stats.R` 的顶层 `i`（一格 int）被当成模块级变量，
 * 于是 `main` 开头要给它摆零值，而标量在这门语言这边没有零值可摆 → 当场炸。
 *
 * 绑过的名字有三处来源：形参、`<-` 赋值的那格名字、`for` 的循环量。`<<-` **不算绑**
 * （那一句的意思正相反：写的就是外面那格）。`xs[i] <- …` 也不算绑 —— 被赋的是元素，
 * 那格 `xs` 本身还是从外面来的（这一点与真 R 的"改元素先复制一份"有出入，见 SPEC §4）。
 */
function freeSyms(fnNode) {
  const body = kids(fnNode)[1];
  const bound = new Set(formalsOf(fnNode));
  eachAssign(body, ({ target, op }) => {
    if (op !== '<<-' && tag(target) === 'sym') bound.add(mangle(nameOf(target)));
  });
  const walkFor = (y) => {
    if (!isList(y)) return;
    if (tag(y) === 'for') bound.add(mangle(nameOf(kids(kids(y)[0])[0])));
    for (const k of kids(y)) walkFor(k);
  };
  walkFor(body);
  const out = new Set();
  const walk = (y) => {
    if (!isList(y)) return;
    if (tag(y) === 'sym') {
      const nm = mangle(nameOf(y));
      if (!bound.has(nm)) out.add(nm);
    }
    for (const k of kids(y)) walk(k);
  };
  walk(body);
  return out;
}

/* ─── 实参表 ───────────────────────────────────────────────────────────── */

/**
 * `(call f (arg e) (named-arg (sym k) e) …)` → `[{name, value}]`。
 *
 * 空的 `(arg)` 是 R 里真有的一格（`x[, 1]` / `f(a, )`），所以 `value` 可以是 null。
 * **只有一格而且是空的，那就是"没有实参"** —— R 的语法里 `f()` 走的正是
 * `sublist -> sub` 加 `sub -> ε`（gram.y:545/549），所以 `list()` 与 `f()` 都长这样。
 */
function argsOf(x) {
  const out = [];
  for (const a of kids(x).slice(1)) {
    if (tag(a) === 'arg') out.push({ name: null, value: kids(a)[0] ?? null });
    else if (tag(a) === 'named-arg') {
      const ks = kids(a);
      out.push({ name: nameOf(ks[0]), value: ks[1] ?? null });
    }
  }
  if (out.length === 1 && out[0].name === null && out[0].value === null) return [];
  return out;
}

/** 位置实参（命名的挑出去）。 */
const posArgs = (x) => argsOf(x).filter((a) => a.name === null).map((a) => a.value);
/** 一格命名实参的值（没有回 undefined）。 */
const namedArg = (x, k) => argsOf(x).find((a) => a.name === k)?.value;

/* ─── 表达式 ───────────────────────────────────────────────────────────── */

const b = (op, left, right) => ({ kind: 'binop', op, left, right });
const call1 = (name, ...args) => ({ kind: 'builtin', name, args });
/** 一格类型当实参用（`(anew (arr int) N)` 的第一格）—— 与 `ext/chez/adapter/expr.js` 同一格。 */
const tyArg = (type) => ({ kind: 'type', type });

/** 临时量的名字。一趟 `rToIR` 里从 0 起（出来的 `.sx` 要能进快照，不许带上一趟的号）。 */
let tmpN = 0;
const fresh = (p) => `r_${p}${tmpN++}`;

/**
 * 一格值变成 `double`（nmath 的每一格实参都是 f64）。
 * 已经是实数的**不包 `toreal`** —— 包了照样对，但 `.sx` 里会多出一层
 * `(toreal (real 0.5))` 这种明显的废话，而那种废话读的人会当成有意思的东西。
 */
/**
 * 一格数当"取几格"用（`head(v, 3)` / `rep(x, 4)` 的第二格）→ int。
 * R 那边这几个位置写小数是合法的（会截断），所以 real 那一档走 `toint` 而不是当场报。
 */
const asIntE = (e, ty) => {
  if (e.kind === 'int') return e;
  if (e.kind === 'real') return { kind: 'int', value: Math.trunc(e.value) };
  return ty !== undefined && ty.kind === 'int' ? e : call1('toint', e);
};

/**
 * **逻辑当数用**：R 里 `TRUE` / `FALSE` 在算术与比较里就是 1 / 0
 * （`TRUE + TRUE` 是 2、`TRUE * 3` 是 3 —— 量出来的）。方言里 bool 上没有算术，
 * 所以这儿摊成一格 int（字面量直接折，别的落一格三元）。不是 bool 的原样过。
 */
const asNumE = (e, ty) => {
  if (e.kind === 'bool') return { kind: 'int', value: e.value ? 1 : 0 };
  if (ty !== undefined && ty.kind === 'bool') {
    return { kind: 'ternary', cond: e, then: { kind: 'int', value: 1 }, else_: { kind: 'int', value: 0 } };
  }
  return e;
};

const asReal = (e, ty) => {
  if (e.kind === 'real') return e;
  if (e.kind === 'int') return { kind: 'real', value: e.value };
  /* `TRUE` / `FALSE` 在 R 里当数用就是 1 / 0（`sum(c(TRUE,TRUE))` 是 2）。
     方言里 bool 与 real 之间没有转换，所以摊成一格三元。 */
  if (e.kind === 'bool') return { kind: 'real', value: e.value ? 1 : 0 };
  if (ty !== undefined && ty.kind === 'bool') {
    return { kind: 'ternary', cond: e, then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } };
  }
  if (ty !== undefined && ty.kind === 'real') return e;
  return call1('toreal', e);
};

/**
 * 转发到 R 自己的 C：`(ccall sym …)`。
 *
 * 摆位的规矩与 R 的形参一样：**位置实参从左往右填格子，没填到的格子取缺省值**。
 * 于是 `dnorm(1)` → `dnorm4(1, 0, 1, 0)`、`dnorm(1, 2)` → `dnorm4(1, 2, 1, 0)`，
 * 而 `pnorm(q, mean, sd, lower.tail)` 那第四格在 R 里**本来就是** `lower.tail` ——
 * 按位置盖掉缺省值不是网开一面，是照 R 的形参表。
 *
 *   spec.fill —— 一格一个缺省值；`null` = 没有缺省值（R 那边必给）
 *   spec.take —— R 那边最多许给几格位置实参（默认 = 格子数）。只有"R 的形参与 C 的形参
 *                不是一一对应"的那几格要写它：`besselI(x, nu, expon.scaled)` 的第三格在
 *                R 里是 TRUE/FALSE，在 C 里是 1/2 —— 按位置传过去就是静默答错，所以只收两格。
 */
function rmathCall(rname, spec, args, argTys) {
  const need = spec.fill.filter((f) => f === null).length;
  const take = spec.take ?? spec.fill.length;
  if (args.length < need) {
    throw new Error(`r->IR: ${rname}() 至少要 ${need} 格实参（给了 ${args.length}）`);
  }
  if (args.length > take) {
    throw new Error(`r->IR: ${rname}() 这一批只接 ${take} 格位置实参（给了 ${args.length}）——`
      + ` 再往后那几格在 ${spec.sym}() 那侧的口径与 R 的形参不是一一对应的，`
      + '收下再忽略就是静默答错');
  }
  /* 签名从那份生成出来的头里查，查不到当场报（`rt/ffi.js` 会说清是名字错还是版本错）。
     顺手核一遍元数：表里 `fill` 的长度必须等于 C 那边的形参个数 —— 这一格是**这张表与
     那棵源码树之间的锁**（R 改了某个函数的元数，这儿就会报，而不是传错参数）。 */
  const sig = rmathSig(spec.sym);
  if (sig.params.length !== spec.fill.length) {
    throw new Error(`r->IR: ${spec.sym}() 在 Rmath.h 里收 ${sig.params.length} 格，`
      + `而这张表按 ${spec.fill.length} 格摆 —— RMATH 那一行与参考树走散了`);
  }
  cabiUsed.add(spec.sym);
  const out = spec.fill.map((f, i) => {
    const e = i < args.length ? args[i] : { kind: 'int', value: f };
    /* `i32` 那几格是 R 的 `lower.tail` / `log` 旗子，按整数走；别的一律 double。 */
    const ty = i < args.length ? argTys[i] : undefined;
    return sig.params[i] === 'i32' ? e : asReal(e, ty);
  });
  /* `bump`：给第一个实参加个常数（只有 `factorial` 用 —— R 把它定义成 `gamma(x+1)`）。
     摆在这儿而不是调用点上，是因为"第一格是向量就逐元素"那一层在上头，写在那儿就要写两遍。 */
  if (spec.bump !== undefined) out[0] = b('+', out[0], { kind: 'real', value: spec.bump });
  return { kind: 'ccall', sym: spec.sym, args: out };
}


/* ─── 合成几格 CST 节点（给"摊成元素再套一遍"那种改写用） ────────────────
 *
 * 为什么要合成节点而不是另写一份逐元素的排版：`sprintf` 的排版那一大段（旗子 / 宽度 /
 * 精度 / 进制 / 两套有效数字）只该有**一份**实现。把向量实参换成一格标量临时量的
 * `(sym …)`、再拿一格合成的 `sprintf(fmt, 那几格临时量)` 递归下来，那一份就照用。
 */
const cstList = (t, ...ks) => ({ kind: 'list', items: [{ kind: 'atom', value: t }, ...ks] });
const cstSym = (nm) => cstList('sym', { kind: 'atom', value: nm });
const cstCall = (fnName, argVals) => cstList(
  'call', cstSym(fnName), ...argVals.map((v) => cstList('arg', v)),
);

/**
 * `sprintf(fmt, …)` —— **格式串在编译期就拆开**，落成一串接起来的片段。
 *
 * 为什么能这么做：R 的 `sprintf` 的格式串在真实代码里几乎总是字面量，而方言里没有
 * "运行期解析格式串"那一格（那是 `printf` 那一族的事，见 `lower/fmt.js`）。所以这儿的
 * 规矩是：**字面量才接，不是字面量当场报** —— 不假装支持一半。
 *
 * 认的是 `%[-][宽][.精度]{d,i,s,f,e,g}` 与 `%%`。位数那几格直接落方言的
 * `(sfix …)` / `(ssci …)` / `(sgen …)`（就是 C 的 `%.Nf` / `%.Ne` / `%.Ng`），
 * 所以"印出来什么"这件事仍然只有一份实现。`%s` 上的数走 15 位有效数字那一档
 * （R 的 `sprintf("%s", 1/3)` 与 `as.character` 同口径）。
 */
function sprintfOf(x, types) {
  const args = posArgs(x);
  if (args.length === 0) throw new Error('r->IR: sprintf() 至少要一格格式串');
  if (tag(args[0]) !== 'str') {
    throw new Error('r->IR: sprintf() 的格式串只接**字面量** —— 运行期拆格式串那一层没有，'
      + ' 而"支持一半"比当场报更糟');
  }
  const fmt = String(leaf(kids(args[0])[0]));
  const rest = args.slice(1);
  /**
   * **有一格实参是向量 → R 出一整条字符向量**（`sprintf("%d: %s", 1:3, ns)` 是常用写法）。
   *
   * 办法是"摊成元素、再套一遍同一条排版"：每格向量实参存进一格临时量、逐格取出来绑到
   * 一格标量临时量上，然后拿一格**合成的** `sprintf(fmt, 那几格标量)` 调用节点递归下来
   * （`cstCall` / `cstSym`）—— 于是旗子 / 宽度 / 精度 / 进制那一大段只有一份实现。
   *
   * 长度按 R 的回收取**最长**的那一格（`sprintf("%d-%d", 1:2, 1:4)` 出 4 格，量出来的）；
   * 有一格是零长就整条零长（`character(0)`），那时循环一圈都不转 —— 也就不会对 0 取模。
   */
  const vecAt = rest.map((a) => {
    const t = typeOfExpr(a, types);
    return isVecTy(t) || isStrVec(t);
  });
  if (vecAt.some((v) => v)) {
    const nm = (s) => ({ kind: 'name', name: s });
    const I = (v) => ({ kind: 'int', value: v });
    const stmts = [];
    const child = new Map(types);
    const elems = [];
    const lens = [];
    const subst = rest.map((a, k) => {
      if (!vecAt[k]) return a;
      const t = typeOfExpr(a, types);
      const str = isStrVec(t);
      const vn = fresh('sv');
      const ln = fresh('sn');
      stmts.push({ kind: 'let', name: vn, type: str ? RSTRV : t, init: exprOf(a, types) });
      stmts.push({
        kind: 'let', name: ln, type: INT, init: str ? svLen(nm(vn)) : vecLen(nm(vn)),
      });
      lens.push(nm(ln));
      const en = fresh('se');
      const et = str ? STR : (isLglTy(t) ? RLGL1 : REAL);
      child.set(en, et);
      elems.push({ en, vn, ln, str, et });
      return cstSym(en);
    });
    const mv = fresh('sm');
    stmts.push({ kind: 'let', name: mv, type: INT, init: lens[0] });
    for (const l of lens.slice(1)) {
      stmts.push({ kind: 'if', cond: b('>', l, nm(mv)), then: [{ kind: 'assign', target: nm(mv), value: l }], else_: null });
    }
    /* 有一格是零长就整条零长（R 的口径）—— 这一句摆在取最长之后，才盖得住。 */
    for (const l of lens) {
      stmts.push({ kind: 'if', cond: b('==', l, I(0)), then: [{ kind: 'assign', target: nm(mv), value: I(0) }], else_: null });
    }
    const out = fresh('so');
    stmts.push({ kind: 'let', name: out, type: RSTRV, init: call1('anew', tyArg(RSTRV), nm(mv)) });
    const iv = fresh('si');
    const body = elems.map((e) => ({
      kind: 'let',
      name: e.en,
      type: e.et,
      init: e.str
        ? svGet(nm(e.vn), b('%', nm(iv), nm(e.ln)))
        : vecGet(nm(e.vn), b('%', nm(iv), nm(e.ln))),
    }));
    body.push({
      kind: 'assign',
      target: svGet(nm(out), nm(iv)),
      value: sprintfOf(cstCall('sprintf', [args[0], ...subst]), child),
    });
    stmts.push({
      kind: 'for',
      init: { kind: 'let', name: iv, type: INT, init: I(0) },
      cond: b('<', nm(iv), nm(mv)),
      post: { kind: 'assign', target: nm(iv), value: b('+', nm(iv), I(1)) },
      body,
    });
    return { kind: 'block-expr', stmts, value: nm(out) };
  }
  const S = (v) => ({ kind: 'string', value: v });
  const pieces = [];
  let lit = '';
  let ai = 0;
  const nextArg = () => {
    if (ai >= rest.length) throw new Error(`r->IR: sprintf("${fmt}") 的实参不够用`);
    const a = rest[ai];
    ai += 1;
    return a;
  };
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%') { lit += fmt[i]; continue; }
    if (fmt[i + 1] === '%') { lit += '%'; i += 1; continue; }
    const m = /^%([-+0 ]*)(\d*)(?:\.(\d+))?([disfeEgGxXo])/.exec(fmt.slice(i));
    if (m === null) {
      throw new Error(`r->IR: sprintf 的 "${fmt.slice(i, i + 4)}" 这一格转换还没接`
        + '（认的是 %[-+0 ][宽][.精度]{d,i,s,f,e,E,g,G,x,X,o} 与 %%）');
    }
    if (lit !== '') { pieces.push(S(lit)); lit = ''; }
    const [all, flags, wid, prec, conv] = m;
    const dash = flags.includes('-');
    const zero = flags.includes('0');
    const plus = flags.includes('+');
    const space = flags.includes(' ');
    const node = nextArg();
    const t = typeOfExpr(node, types);
    if (isVecTy(t) || isStrVec(t)) {
      throw new Error('r->IR: sprintf() 的实参是向量 —— R 那一格会出一整条串向量，这一层没有');
    }
    let piece;
    let signOf = null;   /* `+` / 空格那两个旗子要问"这个数是不是非负" */
    if (conv === 's') piece = asStr(node, types, 15);
    else if (conv === 'd' || conv === 'i') {
      const e = asIntE(exprOf(node, types), t);
      piece = call1('tostr', e);
      signOf = b('>=', e, { kind: 'int', value: 0 });
    } else if (conv === 'x' || conv === 'X' || conv === 'o') {
      /* `(sbase E 进制)` —— 那一条明写着"E 的位当**无符号 64 位**读"，与 C 的 `%x` 同解。 */
      const base = conv === 'o' ? 8 : 16;
      const h = call1('sbase', asIntE(exprOf(node, types), t), { kind: 'int', value: base });
      piece = conv === 'X' ? call1('supper', h) : h;
    } else {
      const p = prec === undefined ? 6 : Number(prec);
      const e = asReal(exprOf(node, types), t);
      piece = conv === 'f' ? call1('sfix', e, { kind: 'int', value: p })
        : (conv === 'e' || conv === 'E' ? call1('ssci', e, { kind: 'int', value: p })
          : call1('sgen', e, { kind: 'int', value: prec === undefined ? 6 : p }));
      if (conv === 'E' || conv === 'G') piece = call1('supper', piece);
      signOf = b('>=', e, { kind: 'real', value: 0 });
    }
    /* `+` 与空格：C 只在**非负**时补那一格（负数自己带 `-`）。 */
    if ((plus || space) && signOf !== null) {
      piece = b('+', {
        kind: 'ternary', cond: signOf, then: S(plus ? '+' : ' '), else_: S(''),
      }, piece);
    }
    if (wid !== '') {
      const w = { kind: 'int', value: Number(wid) };
      /* `0` 旗子：补零而不是补空格，而且**符号要留在最前**（`%05.1f` 的 -1.5 是 `-01.5`）。
         `-`（左对齐）与 `0` 撞上时 C 里 `-` 赢。 */
      const helper = dash ? 'r_padr' : (zero ? 'r_pad0' : 'r_padl');
      piece = lglCall(helper, piece, w);
    }
    pieces.push(piece);
    i += all.length - 1;
  }
  if (lit !== '') pieces.push(S(lit));
  if (pieces.length === 0) return S('');
  return pieces.reduce((acc, p) => b('+', acc, p));
}

/**
 * `strsplit(s, sep)` —— 按一段**定串**切开，回一条字符向量。
 *
 * R 那边它回的是一张**表**（每格一条字符向量），而这一层没有"表里装向量"那一格。
 * 所以只接真代码里那两种形状：`strsplit(s, sep)[[1]]` 与 `unlist(strsplit(s, sep))` ——
 * 两者同解（只有一个输入串时那张表就一格）。裸着写当场报，不假装。
 *
 * `split` 在 R 里默认是**正则**。所以这儿只收"没有正则元字符的串字面量"，或者明写了
 * `fixed = TRUE`（那时任意字面量都行）。不是字面量的当场报 —— 那时没法知道它是不是正则。
 */
const RE_META = /[.\\|()[\]{}^$*+?]/;
function splitOf(callNode, types) {
  const args = posArgs(callNode);
  if (args.length !== 2) {
    throw new Error(`r->IR: strsplit() 要两格实参（给了 ${args.length}）`);
  }
  const fixedNode = namedArg(callNode, 'fixed');
  const fixed = fixedNode !== undefined
    && tag(fixedNode) === 'num' && ['TRUE', 'T'].includes(String(leaf(kids(fixedNode)[0])));
  if (tag(args[1]) !== 'str') {
    throw new Error('r->IR: strsplit() 的 `split=` 只接串字面量 —— R 那边它默认是**正则**，'
      + '不是字面量就没法知道它是不是一条正则（正则那一层没有）');
  }
  const sep = String(leaf(kids(args[1])[0]));
  if (!fixed && RE_META.test(sep)) {
    throw new Error(`r->IR: strsplit() 的 "${sep}" 里有正则元字符 —— R 默认按正则切，`
      + ' 而正则那一层没有。真想按定串切就写 `fixed = TRUE`');
  }
  const st = typeOfExpr(args[0], types);
  if (st.kind !== 'string') throw new Error(`r->IR: strsplit() 的第一格实参要是一格串（是 ${st.kind}）`);
  return {
    kind: 'call',
    fn: { kind: 'name', name: useFn('r_split') },
    args: [exprOf(args[0], types), { kind: 'string', value: sep }],
  };
}
/** 这一格是不是 `strsplit(…)` 那一次调用（`[[1]]` 与 `unlist` 两处都要问）。 */
const isSplitCall = (node) => isList(node) && tag(node) === 'call'
  && tag(kids(node)[0]) === 'sym' && nameOf(kids(node)[0]) === 'strsplit';

/** 那格命名实参是不是写着字面量 `TRUE`（`fixed=` / `value=` 两处都这么问）。 */
function trueFlag(callNode, name) {
  const node = namedArg(callNode, name);
  if (node === undefined) return false;
  const txt = tag(node) === 'num' ? String(leaf(kids(node)[0])) : null;
  if (txt === 'TRUE' || txt === 'T') return true;
  if (txt === 'FALSE' || txt === 'F') return false;
  throw new Error(`r->IR: ${name}= 只认字面量 TRUE / FALSE（给的是一格要算的值）`);
}

/**
 * `grepl` / `grep` / `sub` / `gsub` 那一格**要找的东西** —— 与 `strsplit` 同一条规矩：
 * 只收串字面量，而且**没有正则元字符**（或者明写了 `fixed = TRUE`）。
 *
 * 为什么不是"接了正则"：R 这一族默认按 POSIX 扩展正则匹配，而正则那一层这儿没有。
 * 不是字面量时连"它是不是一条正则"都不知道 —— 那时假装按定串找就是静默答错。
 * 好在真代码里这一族的实参多半就是定串（`gsub(",", "", s)`），所以这一半覆盖得住。
 */
function litPat(callNode, fn, node) {
  if (!isList(node) || tag(node) !== 'str') {
    throw new Error(`r->IR: ${fn}() 的 pattern 只接串字面量 —— R 那边它默认是**正则**，`
      + '不是字面量就没法知道它是不是一条正则（正则那一层没有）');
  }
  const p = String(leaf(kids(node)[0]));
  if (p === '') {
    throw new Error(`r->IR: ${fn}() 的 pattern 是空串 —— R 那一档是"每个字符之间都算一次"`
      + '（`gsub("", "-", "abc")` 是 `"-a-b-c-"`），这儿没接');
  }
  if (!trueFlag(callNode, 'fixed') && RE_META.test(p)) {
    throw new Error(`r->IR: ${fn}() 的 "${p}" 里有正则元字符 —— R 默认按正则找，`
      + ' 而正则那一层没有。真想按定串找就写 `fixed = TRUE`');
  }
  return { kind: 'string', value: p };
}

/**
 * `grepl` / `grep` / `sub` / `gsub` → 一格表达式。
 *
 * 一格串上的 `grepl` 直接落成 `(sfind s p) >= 0`（不必发函数）；字符向量那几档各走一格
 * 生成出来的辅助函数。`sub` 与 `gsub` 是同一个函数带一格"换几次"的旗子。
 */
function findOf(fn, x, types) {
  const args = posArgs(x);
  const arity = fn === 'grepl' || fn === 'grep' ? 2 : 3;
  if (args.length !== arity) {
    throw new Error(`r->IR: ${fn}() 要 ${arity} 格实参（给了 ${args.length}）`);
  }
  const pat = litPat(x, fn, args[0]);
  const subj = arity === 2 ? args[1] : args[2];
  const st = typeOfExpr(subj, types);
  if (st.kind !== 'string' && !isStrVec(st)) {
    throw new Error(`r->IR: ${fn}() 要找的那一格是串或字符向量（推出来是 ${st.kind}）`);
  }
  const s = exprOf(subj, types);
  if (fn === 'grepl') {
    return isStrVec(st)
      ? lglCall('r_grepl_v', s, pat)
      : b('>=', call1('sfind', s, pat), { kind: 'int', value: 0 });
  }
  if (fn === 'grep') {
    if (!isStrVec(st)) {
      throw new Error('r->IR: grep() 的第二格实参要是一条字符向量 —— 一格串上写 grepl()');
    }
    return lglCall(trueFlag(x, 'value') ? 'r_grep_s' : 'r_grep_i', s, pat);
  }
  const rt = typeOfExpr(args[1], types);
  if (rt.kind !== 'string') {
    throw new Error(`r->IR: ${fn}() 换上去的那一格要是串（推出来是 ${rt.kind}）`
      + ' —— R 的 `\\1` 那种回引用要正则，没接');
  }
  const rep = exprOf(args[1], types);
  const all = { kind: 'int', value: fn === 'gsub' ? 1 : 0 };
  return isStrVec(st)
    ? lglCall('r_gsub_v', s, pat, rep, all)
    : lglCall('r_gsub', s, pat, rep, all);
}
/** 这一格是不是 `名字(…)` 那一次调用（`unlist(lapply(…))` 要问）。 */
const isApplyCall = (node, name) => isList(node) && tag(node) === 'call'
  && tag(kids(node)[0]) === 'sym' && nameOf(kids(node)[0]) === name;

/**
 * 不认识的那个名字，**指一条路**。
 *
 * 分三档说：包那一层（`library`）、表格与属性那一层（`data.frame` / `names`）、
 * 剩下的（base 里我们还没接的那些）。CRAN 的包那一档是 libR（ADR-0046，SPEC 第五节）——
 * 编译器这一档永远接不住 ggplot2 那 13.5 万行 R，说清楚比让人猜快。
 */
const PKG_FNS = new Set(['library', 'require', 'requireNamespace', 'attachNamespace', 'loadNamespace']);
const TBL_FNS = new Set([
  /* `names` / `setNames` / `unname` **已经接了一半**（见 `RNVEC`），所以它们不在这张表里
     —— 接不住的那几格由 `callOf` 自己报，报得比这条通用指路准。 */
  'data.frame', 'matrix', 'colnames', 'rownames', 'attr', 'attributes',
  'nrow', 'ncol', 'dim', 'cbind', 'rbind', 'apply', 'aggregate', 'merge', 'table', 'factor',
]);
function gapHint(fn) {
  if (PKG_FNS.has(fn)) {
    return '包那一层（`library()` / 命名空间）在编译器这一档没有。CRAN 的包（ggplot2 / Rcpp…）'
      + '走的是 **libR 那一档**：`node ext/r/build-libR.js` + `node ext/r/install-cran.js`，'
      + '再用 `.omni-cache/r-rt/libR/home/bin/exec/R -f 那份脚本`（见 ext/r/SPEC.md 第五节）';
  }
  if (TBL_FNS.has(fn)) {
    return '表格与属性那一层（`data.frame` / `names` / `dim` / `class`）还没有'
      + '（见 ext/r/SPEC.md 第四节第 4 条）—— 向量、字符向量与 `list()` 当表用那三格有';
  }
  return '编译器这一档只认 `BUILTINS` 那张表里的内建（见 ext/r/SPEC.md 第三节）'
    + '与这份源码里自己定义的函数。如果它是某个包里的，那一档是 libR（SPEC 第五节）';
}

/**
 * 尾位上那一格 `switch` 是**语句**还是**值**。
 *
 * R 里两种都常见：`f <- function(k) switch(k, a = "A", "其他")` 交的是值，而
 * `switch(kind, a = cat("…"), b = cat("…"))` 是分支做事、不交值。判据是**每一支都在干什么**：
 * 每一支都是"只能摆在语句位上的那几格"（`cat` / `print` / `stop` / 赋值…）就按语句落，
 * 否则按值落。这样不必靠"先试一次、报错了再换一条路"—— 那种写法会把真错吞掉。
 */
const STMT_ONLY_FNS = new Set(['cat', 'print', 'set.seed', 'stop', 'stopifnot']);
function switchIsStmt(x) {
  const arms = argsOf(x).slice(1).filter((a) => a.value !== null).map((a) => a.value);
  if (arms.length === 0) return true;
  return arms.every((v) => {
    if (isAssign(v)) return true;
    if (tag(v) === 'block' || tag(v) === 'for' || tag(v) === 'while' || tag(v) === 'repeat') return true;
    if (tag(v) === 'call' && tag(kids(v)[0]) === 'sym') return STMT_ONLY_FNS.has(nameOf(kids(v)[0]));
    return false;
  });
}

/**
 * `switch(EXPR, …)` —— 落成一条 if 链。
 *
 * R 的这一格有两套完全不同的规矩，按**选择子的类型**分（`do_switch`）：
 *
 *   * 选择子是**串**：分支按名字配。`a = , b = 2` 那种**空分支往下落**（`switch("a", a=, b=2)`
 *     是 2）；最后一格**没名字**的是兜底。
 *   * 选择子是**数**：分支按位置配（1 起），分支不该有名字。
 *
 * 没配上时 R 回的是"不可见的 `NULL`" —— 这一层没有 `NULL`：
 *   * **语句位**上那正好是"什么都不做"，一格 else 都不发；
 *   * **表达式位**上当场报（要一格兜底）—— 假装回 0 就是静默答错。
 *
 * `asStmt` 分这两条路：语句位上每一支是**语句**（`cat(…)` 只能摆在语句位，见文件头第 2 条），
 * 表达式位上每一支是**值**，落方言的 `if-expr`（那一格每支自己一个语句槽，所以是懒的 ——
 * R 也只求被选中的那一支）。
 */
function switchOf(x, types, asStmt) {
  const args = argsOf(x);
  if (args.length < 2) throw new Error(`r->IR: switch() 至少要"选择子 + 一格分支"（给了 ${args.length}）`);
  if (args[0].name !== null) throw new Error('r->IR: switch() 的第一格实参是选择子，不该带名字');
  const sel = args[0].value;
  const arms = args.slice(1);
  const st = typeOfExpr(sel, types);
  const body = (node) => (asStmt ? stmtOf(node, types) : exprOf(node, types));

  /* 数那一档：按位置配（1 起）。 */
  if (st.kind !== 'string') {
    if (arms.some((a) => a.name !== null)) {
      throw new Error('r->IR: switch() 的选择子是数时，分支是**按位置**配的，不该带名字'
        + '（R 那儿名字会被当成"这一格叫什么"而不是分支）');
    }
    if (!asStmt) {
      /* 位置那一档**没有"兜底"这个写法**（多写一格就是多一个位置），而越界时 R 回 `NULL`。
         所以表达式位上这一格当场报 —— 回 0 或者"回最后一支"都是静默答错。 */
      throw new Error('r->IR: 表达式位上的 `switch(数, …)` 还没接 —— 越界时 R 回 `NULL`，'
        + ' 而这一层没有 `NULL`，位置那一档也没有"兜底"的写法。'
        + ' 写成 if / else if，或者 `switch(as.character(i), "1" = …, …, 兜底)`');
    }
    const selE = asIntE(exprOf(sel, types), st);
    const tmp = fresh('sw');
    const pick = { kind: 'name', name: tmp };
    let out = null;
    for (let i = arms.length - 1; i >= 0; i--) {
      out = {
        kind: 'if',
        cond: b('==', pick, { kind: 'int', value: i + 1 }),
        then: [body(arms[i].value)],
        else_: out === null ? null : [out],
      };
    }
    return { kind: 'block', stmts: [{ kind: 'let', name: tmp, type: INT, init: selE }, out] };
  }

  /* 串那一档：名字配 + 空分支往下落 + 最后那格没名字的当兜底。 */
  let dflt = null;
  const groups = [];          /* { keys: [名字…], value: 那棵树 } */
  let pending = [];
  for (const a of arms) {
    if (a.name === null) {
      if (dflt !== null) throw new Error('r->IR: switch() 只接一格兜底（没名字的那一格）');
      if (pending.length > 0) throw new Error('r->IR: switch() 的空分支后面要跟一格带名字的分支');
      dflt = a.value;
      continue;
    }
    if (a.value === null) { pending.push(a.name); continue; }   /* `a = ,` —— 往下落 */
    groups.push({ keys: [...pending, a.name], value: a.value });
    pending = [];
  }
  if (pending.length > 0) throw new Error('r->IR: switch() 最后一格分支是空的（R 那儿它落到哪儿都没有）');
  if (groups.length === 0) throw new Error('r->IR: switch() 一格带名字的分支都没有');
  const tmp = fresh('sw');
  const pick = { kind: 'name', name: tmp };
  const condOfKeys = (keys) => keys
    .map((k) => b('==', pick, { kind: 'string', value: k }))
    .reduce((acc, c) => b('||', acc, c));
  let out = dflt === null ? null : (asStmt ? body(dflt) : body(dflt));
  for (let i = groups.length - 1; i >= 0; i--) {
    const cond = condOfKeys(groups[i].keys);
    if (asStmt) {
      out = { kind: 'if', cond, then: [body(groups[i].value)], else_: out === null ? null : [out] };
    } else {
      if (out === null) {
        throw new Error('r->IR: 表达式位上的 `switch(串, …)` 要有一格兜底（最后一格不带名字的）'
          + ' —— 没配上时 R 回 `NULL`，而这一层没有 `NULL`（明写在 SPEC）');
      }
      out = {
        kind: 'if-expr', type: typeOfExpr(groups[i].value, types), cond, then: body(groups[i].value), else_: out,
      };
    }
  }
  const decl = { kind: 'let', name: tmp, type: STR, init: exprOf(sel, types) };
  return asStmt
    ? { kind: 'block', stmts: [decl, out] }
    : { kind: 'block-expr', stmts: [decl], value: out };
}

/**
 * `sapply` / `lapply` / `Reduce` / `Filter` —— **把那段匿名函数摊开**，不造函数值。
 *
 * R 里这几格收的是一个函数。这一档没有闭包与函数值那一层（方言有 `fnref` / `call-value`，
 * 但"R 的函数是值"要连着环境一起搬，那是另一刀）。而真代码里这几格的实参**几乎总是就地写的
 * 匿名函数** —— 那时根本不需要函数值：把形参绑到元素上、把函数体当一段表达式摊进循环里就行。
 *
 * 所以这儿只接"就地写的 `function(…) …`"。给一个函数**名字**（`sapply(v, sqrt)`）也当场报 ——
 * 那要真的函数值。判据是 `ext/r/examples/apply.R`。
 *
 * 形参在摊开之后是循环体里的一格 `let`：类型按"元素装什么"给（数值向量出 double、
 * 字符向量出串），函数体的类型再问一遍（于是 `sapply(v, function(x) paste0("#", x))`
 * 出的是一条字符向量）。
 */
function applyOf(fn, x, types) {
  const args = posArgs(x);
  const vr = (nm) => ({ kind: 'name', name: nm });
  const I = (v) => ({ kind: 'int', value: v });
  /* 哪一格是函数、哪一格是数据：`Reduce` / `Filter` 是函数在前，`sapply` 是数据在前。 */
  const fnFirst = fn === 'Reduce' || fn === 'Filter' || fn === 'mapply';
  const initNode = fn === 'Reduce' && args.length === 3 ? args[2] : undefined;
  /* `vapply` 多一格 `FUN.VALUE`（R 拿它定形状）—— 这一层是**推**出来的，所以那一格只检查有没有。 */
  const want = fn === 'Reduce' ? (args.length === 3 ? 3 : 2)
    : ((fn === 'vapply' || fn === 'mapply') ? 3 : 2);
  if (args.length !== want) {
    throw new Error(`r->IR: ${fn}() 这一格接 ${want} 格实参（给了 ${args.length}）`);
  }
  const fnode = fnFirst ? args[0] : args[1];
  const data = fnFirst ? args[1] : args[0];
  if (!isList(fnode) || tag(fnode) !== 'fn') {
    throw new Error(`r->IR: ${fn}() 的那格函数要**就地写成 \`function(…) …\`** —— `
      + '给一个函数名字要真的"函数值"那一层，这一档没有（见 ext/r/SPEC.md）');
  }
  const ps = formalsOf(fnode);
  const nps = (fn === 'Reduce' || fn === 'mapply') ? 2 : 1;
  if (ps.length !== nps) throw new Error(`r->IR: ${fn}() 那格函数要 ${nps} 个形参（给了 ${ps.length}）`);
  const body = kids(fnode)[1];
  const dt = typeOfExpr(data, types);
  const strIn = isStrVec(dt);
  if (!isVecTy(dt) && !strIn) {
    throw new Error(`r->IR: ${fn}() 的那格数据要是一条向量（是 ${dt.kind}）`);
  }
  const elemTy = strIn ? STR : REAL;
  /* **`sapply` / `vapply` 在字符向量上会加名字**（`USE.NAMES = TRUE`）：
     `sapply(c("ab","c"), nchar)` 在 R 里印的是一条**带名字**的向量（名字就是那些串），
     而这一层没有 `names` 那一格。所以这一档当场报 —— 换 `unlist(lapply(…))` 就没有名字，
     两边同解（量出来的）。 */
  if (strIn && (fn === 'sapply' || fn === 'vapply')) {
    throw new Error(`r->IR: ${fn}() 在字符向量上会给结果加名字（R 的 USE.NAMES）——`
      + ' 这一层没有 `names`，写成 `unlist(lapply(v, function(x) …))` 那一格没有名字，两边同解');
  }
  const src = fresh('ap');
  const idx = fresh('ai');
  const len = strIn ? svLen(vr(src)) : vecLen(vr(src));
  const at = (k) => (strIn ? svGet(vr(src), k) : vecGet(vr(src), k));
  const child = new Map(types);
  for (const p of ps) child.set(p, elemTy);
  const pre = [{ kind: 'let', name: src, type: strIn ? RSTRV : dt, init: exprOf(data, types) }];

  if (fn === 'Reduce') {
    /* 折叠：`acc` 的类型按函数体来（数或串），没给初值就拿第一格当初值。 */
    let accTy = typeOfExpr(body, child);
    if (accTy.kind !== 'string') accTy = REAL;
    child.set(ps[0], accTy);
    const acc = fresh('acc');
    const from = initNode === undefined ? I(1) : I(0);
    pre.push({
      kind: 'let',
      name: acc,
      type: accTy,
      init: initNode === undefined
        ? (accTy.kind === 'string' ? at(I(0)) : asReal(at(I(0)), elemTy))
        : (accTy.kind === 'string' ? exprOf(initNode, types) : asReal(exprOf(initNode, types), typeOfExpr(initNode, types))),
    });
    return {
      kind: 'block-expr',
      stmts: [...pre, {
        kind: 'for',
        init: { kind: 'let', name: idx, type: INT, init: from },
        cond: b('<', vr(idx), len),
        post: { kind: 'assign', target: vr(idx), value: b('+', vr(idx), I(1)) },
        body: [
          { kind: 'let', name: ps[0], type: accTy, init: vr(acc) },
          { kind: 'let', name: ps[1], type: elemTy, init: at(vr(idx)) },
          {
            kind: 'assign',
            target: vr(acc),
            value: accTy.kind === 'string' ? exprOf(body, child) : asReal(exprOf(body, child), typeOfExpr(body, child)),
          },
        ],
      }],
      value: vr(acc),
    };
  }

  if (fn === 'Filter') {
    /* 挑出"函数说真"的那些 —— 出来的还是同一种向量。 */
    const out = fresh('fo');
    const k = fresh('fk');
    const keep = condOf(body, child);
    const stmts = [...pre];
    if (strIn) {
      stmts.push({ kind: 'let', name: out, type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) });
    } else {
      stmts.push(...vecNewAs(out, len), { kind: 'let', name: k, type: INT, init: I(0) });
    }
    stmts.push({
      kind: 'for',
      init: { kind: 'let', name: idx, type: INT, init: I(0) },
      cond: b('<', vr(idx), len),
      post: { kind: 'assign', target: vr(idx), value: b('+', vr(idx), I(1)) },
      body: [
        { kind: 'let', name: ps[0], type: elemTy, init: at(vr(idx)) },
        {
          kind: 'if',
          cond: keep,
          then: strIn
            ? [{ kind: 'builtin-stmt', name: 'apush', args: [vr(out), vr(ps[0])] }]
            : [vecSet(vr(out), vr(k), vr(ps[0])), { kind: 'assign', target: vr(k), value: b('+', vr(k), I(1)) }],
          else_: null,
        },
      ],
    });
    if (!strIn) {
      stmts.push({ kind: 'assign', target: { kind: 'deref', expr: vr(out) }, value: call1('toreal', vr(k)) });
    }
    return { kind: 'block-expr', stmts, value: vr(out) };
  }

  if (fn === 'mapply') {
    /**
     * 两条向量**逐元素**（R 的 `mapply`）。长度按**两头回收**：取长的那一条、短的用 `%`
     * 绕回去、有一边零长就出零长 —— 与 `pmax` / `pmin` 同一条（那一格的账在 `r_pmax`）。
     *
     * 字符向量那一侧**当场报**：R 会拿第一条当结果的**名字**（`USE.NAMES`，量出来
     * `mapply(function(a,b) paste0(a,b), c("x","y"), c("1","2"))` 印的是带名字那种），
     * 而这一层没有 `names`。函数体出串也一样没接。
     */
    const dts = [args[1], args[2]].map((d) => typeOfExpr(d, types));
    dts.forEach((t, k) => {
      if (isStrVec(t)) {
        throw new Error('r->IR: mapply() 在字符向量上会给结果加名字（R 的 USE.NAMES）——'
          + ' 这一层没有 `names`');
      }
      if (!isVecTy(t)) throw new Error(`r->IR: mapply() 的第 ${k + 2} 格实参要是一条向量（是 ${t.kind}）`);
    });
    const s2 = [fresh('mp'), fresh('mp')];
    const ns = [fresh('mn'), fresh('mn')];
    const m = fresh('mm');
    const out2 = fresh('mo');
    const i2 = fresh('mi');
    const child2 = new Map(types);
    for (const p of ps) child2.set(p, REAL);
    const bt2 = typeOfExpr(body, child2);
    if (bt2.kind === 'string') {
      throw new Error('r->IR: mapply() 的函数体出串那一档还没接（R 那边结果还会带名字）');
    }
    const lgl2 = bt2.kind === 'bool' || isLgl1(bt2);
    const stmts2 = [
      ...[0, 1].map((k) => ({ kind: 'let', name: s2[k], type: RVEC, init: exprOf(args[k + 1], types) })),
      ...[0, 1].map((k) => ({ kind: 'let', name: ns[k], type: INT, init: vecLen(vr(s2[k])) })),
      { kind: 'let', name: m, type: INT, init: vr(ns[0]) },
      { kind: 'if', cond: b('<', vr(m), vr(ns[1])), then: [{ kind: 'assign', target: vr(m), value: vr(ns[1]) }], else_: null },
      {
        kind: 'if',
        cond: b('||', b('==', vr(ns[0]), I(0)), b('==', vr(ns[1]), I(0))),
        then: [{ kind: 'assign', target: vr(m), value: I(0) }],
        else_: null,
      },
      ...vecNewAs(out2, vr(m)),
      {
        kind: 'for',
        init: { kind: 'let', name: i2, type: INT, init: I(0) },
        cond: b('<', vr(i2), vr(m)),
        post: { kind: 'assign', target: vr(i2), value: b('+', vr(i2), I(1)) },
        body: [
          ...[0, 1].map((k) => ({
            kind: 'let', name: ps[k], type: REAL, init: vecGet(vr(s2[k]), b('%', vr(i2), vr(ns[k]))),
          })),
          vecSet(vr(out2), vr(i2), lgl2
            ? asLgl(exprOf(body, child2), bt2)
            : asReal(exprOf(body, child2), bt2)),
        ],
      },
    ];
    return { kind: 'block-expr', stmts: stmts2, value: vr(out2) };
  }

  /* `sapply` / `unlist(lapply(…))`：一格进一格出，出来的种类看函数体。 */
  const bt = typeOfExpr(body, child);
  const strOut = bt.kind === 'string';
  const lglOut = !strOut && (bt.kind === 'bool' || isLgl1(bt));
  const out = fresh('so');
  const stmts = [...pre];
  if (strOut) {
    stmts.push({ kind: 'let', name: out, type: RSTRV, init: call1('anew', tyArg(RSTRV), len) });
  } else {
    stmts.push(...vecNewAs(out, len));
  }
  stmts.push({
    kind: 'for',
    init: { kind: 'let', name: idx, type: INT, init: I(0) },
    cond: b('<', vr(idx), len),
    post: { kind: 'assign', target: vr(idx), value: b('+', vr(idx), I(1)) },
    body: [
      { kind: 'let', name: ps[0], type: elemTy, init: at(vr(idx)) },
      strOut
        ? { kind: 'assign', target: svGet(vr(out), vr(idx)), value: exprOf(body, child) }
        : vecSet(vr(out), vr(idx), lglOut ? asLgl(exprOf(body, child), bt) : asReal(exprOf(body, child), bt)),
    ],
  });
  return { kind: 'block-expr', stmts, value: vr(out) };
}

/**
 * `r*` 那一族（`runif(n, …)`）→ 一条长度 n 的向量。
 *
 * nmath 那侧的每个函数**只出一个数**（`runif(a, b)`），而 R 那侧第一个实参是"要几个"——
 * 所以这儿开一格向量、转 n 圈，每圈调一次那个 ccall。分布的参数先存进临时量
 * （循环里每圈都要读，不能求好多遍），**次序要紧**：R 是先算参数再抽数。
 */
function randVecOf(fn, x, types) {
  const spec = RRAND.get(fn);
  cabiUsed.add(spec.sym);
  rmathSig(spec.sym);
  const args = posArgs(x);
  if (args.length === 0) throw new Error(`r->IR: ${fn}() 至少要一格实参（"要几个"）`);
  const pre = [];
  const nNm = fresh('rn');
  pre.push({
    kind: 'let',
    name: nNm,
    type: INT,
    init: asIntE(exprOf(args[0], types), typeOfExpr(args[0], types)),
  });
  /* 分布参数：R 那侧给了就用、没给就用缺省值（`null` 是必填 —— 没给当场报）。 */
  const ps = spec.fill.map((def, k) => {
    const node = args[k + 1];
    if (node === undefined) {
      if (def === null) throw new Error(`r->IR: ${fn}() 第 ${k + 2} 格实参是必填的（R 那边没有缺省值）`);
      return { kind: 'real', value: spec.inv ? 1 / def : def };
    }
    const t = typeOfExpr(node, types);
    if (isVecTy(t)) {
      throw new Error(`r->IR: ${fn}() 的分布参数是向量 —— R 那一格是多头回收（每个数各用一套`
        + ' 参数），这一层没做，所以当场报');
    }
    const e = asReal(exprOf(node, types), t);
    const v = spec.inv ? b('/', { kind: 'real', value: 1 }, e) : e;
    const nm2 = fresh('rp');
    pre.push({ kind: 'let', name: nm2, type: REAL, init: v });
    return { kind: 'name', name: nm2 };
  });
  const out = fresh('ro');
  const i = fresh('ri');
  const vr = (n2) => ({ kind: 'name', name: n2 });
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      ...vecNewAs(out, vr(nNm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nNm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        body: [vecSet(vr(out), vr(i), { kind: 'ccall', sym: spec.sym, args: ps })],
      },
    ],
    value: vr(out),
  };
}

/**
 * 下标从 1 起 → 从 0 起。字面量当场折掉（`x[1]` 出 `aget(x, 0)` 而不是 `1-1`）。
 *
 * `ty` 是那格下标的类型：**它可能是 double**（`for (i in seq_along(xs))` 里的 `i` ——
 * 在向量上遍历，元素是 double），而地址那一侧要 int，所以那一档减完再 `toint`。
 */
function zeroBased(e, ty) {
  if (ty !== undefined && ty.kind === 'real') {
    return call1('toint', b('-', e, { kind: 'real', value: 1 }));
  }
  if (e.kind === 'int') return { kind: 'int', value: e.value - 1 };
  return b('-', e, { kind: 'int', value: 1 });
}

/**
 * 一格值变成串。**`dig` 是有效数字位数** —— R 在这一格有两套口径：
 *
 *   `cat` / `print`                          7（`options(digits)`）
 *   `as.character` / `paste` / `sprintf("%s")`  **15**
 *
 * 所以 `cat(1/3)` 是 `0.3333333` 而 `paste(1/3)` 是 `0.333333333333333` ——
 * 同一个数、两个答案，这不是随手定的，是 R 自己分开的两条路
 * （`as.character` 在 `coerce.c` 里走 `digits = 15`）。挑法都是 `r_num_str`
 * 照 `src/main/format.c` 抄的那一条（定点与科学记数按哪个短挑）。
 *
 * 三态逻辑（`x > 2` 那种）走 `r_lgl_str`：`TRUE` / `FALSE` / `NA` 三档。
 * 这一问要**摆在实数前面** —— 它的 `kind` 也是 `real`。
 */
const asStr = (x, types, dig = 7) => {
  const t = typeOfExpr(x, types);
  if (t.kind === 'string') return exprOf(x, types);
  if (isLgl1(t)) return lglCall('r_lgl_str', exprOf(x, types));
  if (t.kind === 'real') {
    return {
      kind: 'call',
      fn: { kind: 'name', name: useFn(NUM_STR) },
      args: [exprOf(x, types), { kind: 'int', value: dig }],
    };
  }
  /* 布尔在 R 里印 `TRUE` / `FALSE`（不是 `true` / `false`）—— 那是这门语言的写法。 */
  if (t.kind === 'bool') {
    return {
      kind: 'ternary',
      cond: exprOf(x, types),
      then: { kind: 'string', value: 'TRUE' },
      else_: { kind: 'string', value: 'FALSE' },
    };
  }
  return call1('tostr', exprOf(x, types));
};

/**
 * 一格值收成**三态逻辑**（1.0 / 0.0 / NA）。
 *
 * `bool` 那一格当场折成 1 / 0（`TRUE && (x > 2)` 里的左边）；已经是三态的原样过；
 * 别的 double 走 `r_lgl`（R 的 `as.logical`：`NA` 与 `NaN` 都是 `NA`，0 是 `FALSE`，
 * 别的是 `TRUE`）；int 那一格 `!= 0` 再折。
 */
function asLgl(e, t) {
  if (isLgl1(t)) return e;
  if (t.kind === 'bool') {
    return { kind: 'ternary', cond: e, then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } };
  }
  if (t.kind === 'int') {
    return {
      kind: 'ternary',
      cond: b('!=', e, { kind: 'int', value: 0 }),
      then: { kind: 'real', value: 1 },
      else_: { kind: 'real', value: 0 },
    };
  }
  if (t.kind === 'real') return lglCall('r_lgl', e);
  throw new Error(`r->IR: ${t.kind} 当逻辑值用还没接`);
}

/** `x[…]` / `x[[…]]` 的读：按对象的类型分数组还是字典（见文件头第 5 条）。 */
function indexRead(x, types) {
  const obj = kids(x)[0];
  /* `strsplit(s, sep)[[1]]` —— 只有这一格下标有意义（R 那张表只有一格）。 */
  if (isSplitCall(obj)) {
    const ks = kids(x).slice(1).map((a) => kids(a)[0]).filter((k) => k !== undefined);
    const one = ks.length === 1 && tag(ks[0]) === 'num' && String(leaf(kids(ks[0])[0])) === '1';
    if (!one) throw new Error('r->IR: strsplit(…) 上只接 `[[1]]`（R 那张表只有一格）');
    return splitOf(obj, types);
  }
  const keys = kids(x).slice(1).map((a) => kids(a)[0]).filter((k) => k !== undefined);
  if (keys.length !== 1) throw new Error(`r->IR: 多维下标（x[i, j]）还没接（这儿给了 ${keys.length} 格）`);
  const ot = typeOfExpr(obj, types);
  const o = exprOf(obj, types);
  if (ot.kind === 'map') return call1('dget', o, exprOf(keys[0], types));
  if (isVecTy(ot)) {
    /* 下标本身是**向量**那两档（R 里 `xs[xs > 2]` 与 `xs[c(1,3)]` 都是天天写的形状）：
       逻辑向量按掩码挑、数值向量按位置挑，各走一格生成出来的辅助函数。 */
    const kt = typeOfExpr(keys[0], types);
    /* `v["a"]` / `v[["a"]]` —— 带名字的向量上**按名字取**（名字那一条在影子变量里，
       见 `RNVEC`）。找不到那个名字时回 `NA` —— R 也是（`v["zz"]` 印 `<NA>` / `NA`）。 */
    if (kt.kind === 'string' || (isStrVec(kt) && isNamedTy(ot))) {
      if (isStrVec(kt)) {
        throw new Error('r->IR: `v[c("a","b")]` 那种按名字一次取多格还没接'
          + '（挑出来的那几格名字也要跟着走）');
      }
      const ns = namesExprOf(obj, types);
      if (ns === null) {
        throw new Error('r->IR: 按名字取下标只在**带名字的向量**上接'
          + '（`c(a = 1, …)` / `setNames(v, ns)`）—— 这一格推不出名字来');
      }
      return lglCall('r_at_name', o, ns, exprOf(keys[0], types));
    }
    if (isVecTy(kt)) {
      /* 挑出来的那几格 R 会把**名字也挑过去** —— 这一档跟不住，当场报。 */
      if (isNamedTy(ot) || isNamedTy(kt)) {
        throw new Error('r->IR: 在**带名字的向量**上按掩码 / 按位置挑还没接'
          + '（R 会把挑出来的那几格名字也带过去）—— 要不带名字就写 `unname(…)`');
      }
      const helper = isLglTy(kt) ? 'r_vec_mask' : 'r_vec_pick';
      return { kind: 'call', fn: { kind: 'name', name: useFn(helper) }, args: [o, exprOf(keys[0], types)] };
    }
    /* **写着负号的一格标量下标**（`x[-1]` / `x[-i]`）：R 的意思是"丢掉那一格"，
       出来是一条向量。摆成长度 1 的下标向量交给 `r_vec_pick` —— 正负那三条规矩
       只在那一个函数里（见它上面那段账）。 */
    if (isNegSub(keys[0])) {
      return lglCall('r_vec_pick', o, lglCall('r_vec1', asReal(exprOf(keys[0], types), kt)));
    }
    return vecGet(o, zeroBased(exprOf(keys[0], types), typeOfExpr(keys[0], types)));
  }
  /* 字符向量：一格标量下标（`labels[2]`）、按位置挑（`labels[c(1,3)]`）、
     按掩码挑（`labels[nchar(labels) > 2]`）。 */
  if (isStrVec(ot)) {
    const kt = typeOfExpr(keys[0], types);
    if (isVecTy(kt)) {
      const helper = isLglTy(kt) ? 'r_mask_str' : 'r_pick_str';
      return { kind: 'call', fn: { kind: 'name', name: useFn(helper) }, args: [o, exprOf(keys[0], types)] };
    }
    /* `s[-2]` —— 与数值那一侧同一条：摆成长度 1 的下标向量交给 `r_pick_str`。 */
    if (isNegSub(keys[0])) {
      return lglCall('r_pick_str', o, lglCall('r_vec1', asReal(exprOf(keys[0], types), kt)));
    }
    return svGet(o, zeroBased(exprOf(keys[0], types), kt));
  }
  throw new Error(`r->IR: ${nameOf(obj)} 上的下标读不知道是数组还是表 —— 推出来是 ${ot.kind}`);
}

function exprOf(x, types, want) {
  switch (tag(x)) {
    case 'num': return numLit(leaf(kids(x)[0]));
    case 'str': return { kind: 'string', value: leaf(kids(x)[0]) };
    case 'sym': {
      const nm = mangle(nameOf(x));
      /* base 里那几个有名字的常量：**这一段写过这个名字就不算**（见 `BASE_VARS`）。 */
      if (types !== undefined && types.get(nm) === undefined && baseVar(nm) !== undefined) {
        return baseVarExpr(baseVar(nm));
      }
      return { kind: 'name', name: nm };
    }
    case 'paren': return exprOf(kids(x)[0], types);
    case 'sub1': case 'sub2': return indexRead(x, types);
    case 'call': return callOf(x, types, undefined, want);
    case 'pipe': {
      /* `x |> f(…)` 就是 `f(x, …)`（R 在语法动作 `xxpipe` 里当场展开，gram.y:495）。 */
      const [lhs, rhs] = kids(x);
      if (tag(rhs) !== 'call') throw new Error('r->IR: `|>` 右边必须是一次调用（R 自己也这么要求）');
      const e = callOf(rhs, types, exprOf(lhs, types));
      return e;
    }
    case 'un': {
      const op = String(leaf(kids(x)[0]));
      const operand = kids(x)[1];
      if (op === '!') {
        const t = typeOfExpr(operand, types);
        /* 逻辑向量逐元素取反（`!(xs > 2)`），三态标量走 `r_not`（`!NA` 是 `NA`），
           `bool` 那一格仍然是方言的 `!`。 */
        if (isVecTy(t)) return vecMap1(exprOf(operand, types), (e) => lglCall('r_not', e));
        if (t.kind === 'real') return lglCall('r_not', exprOf(operand, types));
        return { kind: 'unop', op: '!', operand: condOf(operand, types) };
      }
      if (op === '-' || op === '+') {
        /* 向量上的一元 `-` 逐元素（`-xs`）—— 方言的 `un` 只吃 int / real。 */
        if (isVecTy(typeOfExpr(operand, types))) {
          return op === '+' ? exprOf(operand, types)
            : vecMap1(exprOf(operand, types), (e) => ({ kind: 'unop', op: '-', operand: e }));
        }
        return { kind: 'unop', op, operand: exprOf(operand, types) };
      }
      throw new Error(`r->IR: 一元 \`${op}\` 还没接`);
    }
    case 'if': {
      /* 表达式位上的 `if` → `ternary`。**只有两支齐全**才行：R 里少一支的值是
         `NULL`（不可见），而方言里没有那一格 —— 当场报，别默默塞一个 0。 */
      const [c, t, e] = kids(x);
      if (e === undefined) throw new Error('r->IR: 表达式位上的 `if` 缺 `else` —— R 那一档的值是 NULL，方言里没有这一格');
      return {
        kind: 'ternary', cond: condOf(c, types), then: exprOf(t, types), else_: exprOf(e, types),
      };
    }
    case 'bin': {
      const [opN, l, r] = kids(x);
      const op = String(leaf(opN));
      if (ASSIGN_OPS.has(op)) throw new Error('r->IR: 表达式位上的赋值还没接（R 里它有值）');
      /* 逻辑那四格。**两边都是 `bool` 时照旧落方言的 `&&` / `||`**（短路照旧，循环里最热的
         那一格不绕）；只要有一边是三态就走 `r_and` / `r_or` 那张三态表。
         `&` / `|` 在向量上是逐元素的，先问 `vecBin`。 */
      if (op === '&&' || op === '&' || op === '||' || op === '|') {
        if (LGL_OPS.has(op)) {
          const vl = vecBin(op, l, r, types);
          if (vl !== null) return vl;
        }
        const lt0 = typeOfExpr(l, types);
        const rt0 = typeOfExpr(r, types);
        if (lt0.kind === 'real' || rt0.kind === 'real') {
          const fn = op === '&&' || op === '&' ? 'r_and' : 'r_or';
          return lglCall(fn, asLgl(exprOf(l, types), lt0), asLgl(exprOf(r, types), rt0));
        }
        if (op === '&&' || op === '&') return b('&&', condOf(l, types), condOf(r, types));
        return b('||', condOf(l, types), condOf(r, types));
      }
      /* `^` 交给 R 自己的 `R_pow`（`src/nmath/mlutils.c`）—— 它对整数指数走反复平方、
         对 `1^x` 与 `x^0` 有明文特例，而 `pow()` 在这几格上与 R 不一样。 */
      if (op === '^' || op === '**') {
        const vp = vecBin(op, l, r, types);
        if (vp !== null) return vp;
        return powOf(asReal(exprOf(l, types), typeOfExpr(l, types)), asReal(exprOf(r, types), typeOfExpr(r, types)));
      }
      /* `%%` 与 `%/%`：**照 R 文档的定义算**（`x - floor(x/y)*y` / `floor(x/y)`），
         于是结果随**除数**取号（`-7 %% 3` 是 2，C 的 `%` 给 -1）。
         这两格 nmath 里没有（R 的 `myfmod` 在解释器那半边 `src/main/arith.c` 里），
         所以是我们按它公开的口径写的 —— 不是抄过来的，也不是 C 的口径。 */
      if (op === '%%' || op === '%/%') {
        /* 一边是向量就逐元素 —— 这两格与 `^` 都走 `vecBin` 里的 `numBin`。 */
        const vm = vecBin(op, l, r, types);
        if (vm !== null) return vm;
        return modOf(op, asReal(exprOf(l, types), typeOfExpr(l, types)), asReal(exprOf(r, types), typeOfExpr(r, types)));
      }
      if (op === ':') return vecSeq(exprOf(l, types), typeOfExpr(l, types), exprOf(r, types), typeOfExpr(r, types));
      /* `x %in% t` —— 左边是一格数时回**三态标量**（那一格能直接进 `if`），
         左边是向量时回逐元素的逻辑向量。两档都用同一条"算不算同一格"（`r_same`）。 */
      if (op === '%in%') {
        const lt2 = typeOfExpr(l, types);
        const rt2 = typeOfExpr(r, types);
        /* 串那一侧接了（只用"相等"）：右边是字符向量时，左边是串就回一格 bool、
           是字符向量就逐元素出逻辑向量。 */
        if (isStrVec(rt2) || rt2.kind === 'string' || isStrVec(lt2) || lt2.kind === 'string') {
          if (!(isStrVec(lt2) || lt2.kind === 'string') || !(isStrVec(rt2) || rt2.kind === 'string')) {
            throw new Error('r->IR: `%in%` 一边是串一边是数 —— R 那边会把数收成串，这一档不替你收');
          }
          const tbl = isStrVec(rt2) ? exprOf(r, types) : lglCall('r_sv1', exprOf(r, types));
          if (isStrVec(lt2)) return lglCall('r_in_str', exprOf(l, types), tbl);
          return lglCall('r_in1_str', exprOf(l, types), tbl);
        }
        const tbl = isVecTy(rt2) ? exprOf(r, types) : lglCall('r_vec1', asReal(exprOf(r, types), rt2));
        if (isVecTy(lt2)) return lglCall('r_in_v', exprOf(l, types), tbl);
        return lglCall('r_in1', asReal(exprOf(l, types), lt2), tbl);
      }
      if (op === '$' || op === '@' || op === '::' || op === ':::' || op === '~' || op === '?') {
        /* `m$k` —— 表上按名字取。R 里 `$` 还能取 data.frame 的列、S4 的槽、环境里的名字，
           那几档都没有（见 SPEC §4 第 4 条），所以只接"左边是一张表"这一种。
           R 的 `$` 还会**部分匹配**（`cfg$to` 能取到 `tol`）—— 这儿不做，写全名。 */
        if (op === '$') {
          const dt = typeOfExpr(l, types);
          if (dt === undefined || dt.kind !== 'map') {
            throw new Error(`r->IR: \`$\` 只接"左边是一张表（\`list(名字 = 值)\`）"那一种`
              + `（左边推出来是 ${dt === undefined ? '不知道' : dt.kind}）——`
              + ' data.frame 的列、S4 的槽、环境那三档都没有（见 ext/r/SPEC.md 第四节第 4 条）');
          }
          return call1('dget', exprOf(l, types), { kind: 'string', value: dollarKey(x) });
        }
        throw new Error(`r->IR: \`${op}\` 还没接`);
      }
      /* **向量化**：一边是向量就逐元素算（R 里这是常态，不是特例）。 */
      {
        const vt = vecBin(op, l, r, types);
        if (vt !== null) return vt;
      }
      /* **数值提升**：R 里 `/` 一律回 double，别的算符只要有一边是 double 就回 double
         （`NA + 1` 也走这条 —— `NA` 是 double）。方言那侧要求两边同型，所以提升在这儿做。
         比较也一样：`1 > 0.5` 两边得先对齐。 */
      const lt = typeOfExpr(l, types);
      const rt = typeOfExpr(r, types);
      const le = exprOf(l, types);
      const re = exprOf(r, types);
      const numeric = ['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!='].includes(op);
      /* **比较那六格：有一边是 double 就回三态逻辑**（`NaN > 2` 是 `NA`）。
         串比较与两边都是 int 的比较照旧落方言的 `bin`（那两档没有 NA）。 */
      if (CMP_FNS.has(op) && lt.kind !== 'string' && rt.kind !== 'string'
          && (lt.kind === 'real' || rt.kind === 'real')) {
        return lglCall(CMP_FNS.get(op), asReal(le, lt), asReal(re, rt));
      }
      if (numeric && (op === '/' || lt.kind === 'real' || rt.kind === 'real')
          && lt.kind !== 'string' && rt.kind !== 'string') {
        return b(op, asReal(le, lt), asReal(re, rt));
      }
      /* **逻辑当数用**（`TRUE + TRUE` 是 2、`TRUE * 3` 是 3）：方言里 bool 上没有算术，
         所以有一边是 bool 就先摊成 int（见 `asNumE`）。比较那几格同理 —— 方言的 bool
         之间没有 `>`，而 R 的 `TRUE > FALSE` 是 `TRUE`。 */
      if (numeric && (lt.kind === 'bool' || rt.kind === 'bool')) {
        return b(op, asNumE(le, lt), asNumE(re, rt));
      }
      return b(op, le, re);
    }
    default:
      throw new Error(`r->IR: 这一格表达式还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/**
 * 逐元素那一族算符。`^` / `%%` / `%/%` 不在里头 —— 它们各自走 `R_pow` 与那条 floor 的算法，
 * 向量化要另摆一层（明写：没做）。
 *
 * `&` / `|` 在里头，而 `&&` / `||` **刻意不在**：R 的 `&&` 只收长度 1 的东西
 * （长向量那一档在新版 R 里是个错误），逐元素的那一对就是 `&` / `|`。
 */
const VEC_OPS = new Set(['+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=', '^', '**', '%%', '%/%', '&', '|', 'xor']);
/** 逐元素的逻辑那几格（结果是逻辑向量，每一格按三态表算）。`xor` 是函数，不是算符。 */
const LGL_OPS = new Set(['&', '|', 'xor']);

/**
 * 一格算符在**两个已经是 double 的值**上怎么算。标量那条路与 `vecBin` 里逐元素那条路
 * 共用这一处 —— 不然 `xs^2` 与 `x^2` 会算成两回事（`^` 必须是 R 的 `R_pow`）。
 */
const powOf = (x, y) => {
  /* `^` 交给 R 自己的 `R_pow`（`src/nmath/mlutils.c`）—— 它对整数指数走反复平方、
     对 `1^x` 与 `x^0` 有明文特例，而 `pow()` 在这几格上与 R 不一样。 */
  cabiUsed.add('R_pow');
  rmathSig('R_pow');
  return { kind: 'ccall', sym: 'R_pow', args: [x, y] };
};
const modOf = (op, x, y) => {
  const q = call1('rmath', { kind: 'strlit', value: 'floor' }, b('/', x, y));
  return op === '%/%' ? q : b('-', x, b('*', q, y));
};
const numBin = (op, x, y) => {
  if (op === '^' || op === '**') return powOf(x, y);
  if (op === '%%' || op === '%/%') return modOf(op, x, y);
  return b(op, x, y);
};

/**
 * **逐元素映射**：一格向量进、一格向量出（`sqrt(xs)` / `-xs` / `abs(xs)` / `round(xs, 1)`）。
 *
 * `mk(elem)` 给"一格 double 上怎么算" —— 与标量那条路**用同一处算法**（`numBin` 那条规矩
 * 在一元这边也管）。`pre` 是要摆在循环前面的语句（比如把 `round(xs, d)` 的 `d` 存进临时量：
 * 循环里要读好多遍，不能求好多遍）。
 */
function vecMap1(vecE, mk, pre = []) {
  const src = fresh('mv');
  const nm = fresh('mn');
  const out = fresh('mo');
  const i = fresh('mi');
  const vr = (x) => ({ kind: 'name', name: x });
  return {
    kind: 'block-expr',
    stmts: [
      ...pre,
      { kind: 'let', name: src, type: RVEC, init: vecE },
      { kind: 'let', name: nm, type: INT, init: vecLen(vr(src)) },
      ...vecNewAs(out, vr(nm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        body: [vecSet(vr(out), vr(i), mk(vecGet(vr(src), vr(i))))],
      },
    ],
    value: vr(out),
  };
}

/**
 * **向量化**：一边是向量就逐元素算。回 `null` 表示"两边都是标量，不是我的活"。
 *
 * R 的回收规则：结果长度取**长的那个**，短的那一边从头再来（`c(1,2,3,4) + c(10,20)` 是
 * `11 22 13 24`）。R 在长的不是短的整数倍时还会**警告**，我们不发警告 —— 那要一条
 * 输出通道，而这一版没有（明写在 SPEC 里）。
 *
 * 落成一格 `block-expr`：先把两边存进临时量（**一次求值** —— 循环里要读好多遍），
 * 再开结果数组，`while` 填，最后拿那格临时量当值。
 */
/** `is.na(x)` 那一问（走按指针的生成函数 —— 载荷按值过 N-API 会丢）。 */
const naQ = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [e] });

/**
 * `a:b` 当**值**用时造出来的那一格向量（`for (v in a:b)` 不走这儿 —— 那边是计数循环）。
 *
 * 按 R 的口径：步长是 ±1、**两头都含**，而 `b < a` 时是**倒着数**（`5:1` 是 `5 4 3 2 1`；
 * `1:0` 是 `1 0` —— 那是 R 里有名的一格坑，所以这儿不当空向量）。
 * 长度 `floor(|b-a|) + 1`，于是 `1.5:3` 是 `1.5 2.5`（R 也是两格）。
 */
function vecSeq(loE, loT, hiE, hiT) {
  const lo = fresh('sl');
  const hi = fresh('sh');
  const nm = fresh('sn');
  const out = fresh('so');
  const i = fresh('si');
  const vr = (x) => ({ kind: 'name', name: x });
  const up = b('>=', vr(hi), vr(lo));
  return {
    kind: 'block-expr',
    stmts: [
      /* 两头**先存进临时量** —— 长度与每一格都要读它们，不能求两遍（`f():g()` 会有副作用）。 */
      { kind: 'let', name: lo, type: REAL, init: asReal(loE, loT) },
      { kind: 'let', name: hi, type: REAL, init: asReal(hiE, hiT) },
      {
        kind: 'let',
        name: nm,
        type: INT,
        init: b('+', call1('toint', { kind: 'ternary', cond: up, then: b('-', vr(hi), vr(lo)), else_: b('-', vr(lo), vr(hi)) }), { kind: 'int', value: 1 }),
      },
      ...vecNewAs(out, vr(nm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        body: [vecSet(vr(out), vr(i), {
          kind: 'ternary',
          cond: up,
          then: b('+', vr(lo), asReal(vr(i), INT)),
          else_: b('-', vr(lo), asReal(vr(i), INT)),
        })],
      },
    ],
    value: vr(out),
  };
}

function vecBin(op, l, r, types) {
  if (!VEC_OPS.has(op)) return null;
  const lt = typeOfExpr(l, types);
  const rt = typeOfExpr(r, types);
  if (!isVecTy(lt) && !isVecTy(rt)) return null;
  if (lt.kind === 'string' || rt.kind === 'string') {
    throw new Error(`r->IR: \`${op}\` 的一边是向量、另一边是串 —— 这一格还没接`);
  }
  const side = (e, ty, name) => {
    /* 标量那一边不入数组：循环里直接读那格临时量（省一次 anew 与一趟 aset）。 */
    const isVec = isVecTy(ty);
    return {
      isVec,
      name,
      decl: {
        kind: 'let', name, type: isVec ? RVEC : REAL, init: isVec ? e : asReal(e, ty),
      },
    };
  };
  const a = side(exprOf(l, types), lt, fresh('vl'));
  const c = side(exprOf(r, types), rt, fresh('vr'));
  const nm = fresh('vn');
  const out = fresh('vo');
  const i = fresh('vi');
  const vr = (x) => ({ kind: 'name', name: x });
  /* 每一边的长度**先存进一格 int**（`vecLen` 是一次内存读 + 一次转换，摆在循环里就是每元素一次）。
     量出来的（bench/r/run.js，2026-09-25）：`vec.R` 原生腿 2.0s → 0.66s。 */
  const lens = [a, c].filter((x) => x.isVec).map((x) => ({ x, nm: fresh('vk') }));
  const lenOf = (x) => vr(lens.find((e) => e.x === x).nm);
  /* 结果长度：两边都是向量取大的，只有一边是向量就是它的长度 */
  const len = a.isVec && c.isVec
    ? { kind: 'ternary', cond: b('>=', lenOf(a), lenOf(c)), then: lenOf(a), else_: lenOf(c) }
    : lenOf(a.isVec ? a : c);
  /* 取第 i 格：标量就是它自己；向量按 `i % 它的长度`（回收）——
     **只有一边是向量时那个取模是废的**（结果长度就是它的长度，`i` 一定在范围里），所以省掉。 */
  const oneVec = !(a.isVec && c.isVec);
  const at = (x) => {
    if (!x.isVec) return vr(x.name);
    return vecGet(vr(x.name), oneVec ? vr(i) : b('%', vr(i), lenOf(x)));
  };
  return {
    kind: 'block-expr',
    stmts: [
      a.decl,
      c.decl,
      ...lens.map((e) => ({ kind: 'let', name: e.nm, type: INT, init: vecLen(vr(e.x.name)) })),
      { kind: 'let', name: nm, type: INT, init: len },
      ...vecNewAs(out, vr(nm)),
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: b('<', vr(i), vr(nm)),
        post: { kind: 'assign', target: vr(i), value: b('+', vr(i), { kind: 'int', value: 1 }) },
        /* 比较那几格在 R 里回**逻辑向量**：1.0 / 0.0 / NA，印成 `TRUE` / `FALSE` / `NA`。
           NA 那一格得按 R 的口径传下去 —— `NA > 2` 与 `NaN > 2` 都是 NA（不是 FALSE），
           而 `is.na` 对这两格都真，所以一问就够。
           `&` / `|` 那两格走三态表（`r_and` / `r_or`）—— 与标量那一侧是同一个函数。 */
        body: [LGL_OPS.has(op)
          ? vecSet(vr(out), vr(i), lglCall(
            op === '&' ? 'r_and' : (op === '|' ? 'r_or' : 'r_xor'), at(a), at(c),
          ))
          : (VEC_CMP.has(op) ? {
            kind: 'if',
            cond: b('||', naQ(at(a)), naQ(at(c))),
            then: [vecSet(vr(out), vr(i), { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] })],
            else_: [vecSet(vr(out), vr(i), { kind: 'ternary', cond: b(op, at(a), at(c)), then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } })],
          } : vecSet(vr(out), vr(i), numBin(op, at(a), at(c))))],
      },
    ],
    value: vr(out),
  };
}
const VEC_CMP = new Set(['<', '<=', '>', '>=', '==', '!=']);

/**
 * 条件。R 要求条件是逻辑值（不像 C 收 0/1），所以这儿只在**字面量**上折一格。
 *
 * 三态那一档走 `r_cond`：`if (NA)` 在 R 里是**报错**
 * （"missing value where TRUE/FALSE needed"），不是当假 —— 那一句在生成出来的函数里
 * 落成 `(fail …)`。为什么是函数而不是摊开：条件位上没地方摆临时量（见 `FN_DEPS` 那段账）。
 */
function condOf(x, types) {
  if (tag(x) === 'paren') return condOf(kids(x)[0], types);
  const t = typeOfExpr(x, types);
  if (t.kind === 'bool') return exprOf(x, types);
  if (t.kind === 'real') return lglCall('r_cond', asLgl(exprOf(x, types), t));
  /* 数当条件：R 的规矩是"不是 0 就是真"（`if (1)` 合法）。 */
  if (t.kind === 'int') {
    return b('!=', exprOf(x, types), { kind: 'int', value: 0 });
  }
  throw new Error(`r->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}

/* ─── 调用（内建在这儿分岔） ───────────────────────────────────────────── */

/**
 * 一次调用。`extra` 是 `|>` 塞到第一位的那格实参。
 * 内建**不是调用** —— 它们落成方言的算子（与 chez 的 `vector-ref` 落 `aget` 同一条）。
 */
function callOf(x, types, extra, want) {
  const fnNode = kids(x)[0];
  const fn = tag(fnNode) === 'sym' ? nameOf(fnNode) : null;
  /* `c(a = 1, b = 2)` 里那几个名字是**元素名**（数据），所以 `c` 这一格要按原序拿**全部**
     实参 —— 别的内建的命名实参是开关，由 `NAMED_OK` 那张表管。 */
  const args = fn === 'c' ? argsOf(x).map((a) => a.value) : posArgs(x);
  const all = extra === undefined ? args : [null, ...args];
  const ev = (i) => (all[i] === null ? extra : exprOf(all[i], types));
  const n = all.length;
  /**
   * **名字跟不住就当场报**（见 `RNVEC` 与 `NAME_DROP_OK`）。R 会把名字带过去的那些
   * （`sort` / `rev` / `head` / `cumsum` / `abs` / `sqrt` / `round` / `is.na` / `c(v, 4)`…）
   * 这一档只带值：静默带过去的话 `print` 会少印名字那一行。用户函数也算 —— 名字那一条
   * 是**跟着变量**走的，传不进被调方。
   */
  if (fn !== null && !NAME_DROP_OK.has(fn)
      && all.some((a) => a !== null && isNamedTy(typeOfExpr(a, types)))) {
    throw new Error(`r->IR: ${fn}() 收了一格**带名字的向量** —— 这一档名字只跟着`
      + '逐元素算术与 `names` / `setNames` / `unname` / `v["a"]` 走（见 ext/r/SPEC.md 第二节）。'
      + `R 里 ${fn}() 会把名字带过去，所以这儿不静默丢 —— 真要丢就写 \`unname(…)\``);
  }
  /**
   * `na.rm = TRUE / FALSE` —— **只认字面量**（运行期的旗子要两条路都发，那是另一件事）。
   * 回 true 时把那格向量先过一遍 `r_drop_na`（见那个函数上的账）。
   */
  const naRmOn = () => {
    const node = namedArg(x, 'na.rm');
    if (node === undefined) return false;
    const txt = tag(node) === 'num' ? String(leaf(kids(node)[0])) : null;
    if (txt === 'TRUE' || txt === 'T') return true;
    if (txt === 'FALSE' || txt === 'F') return false;
    throw new Error(`r->IR: ${fn}() 的 na.rm= 只认字面量 TRUE / FALSE（给的是一格要算的值）`);
  };
  /** 那格向量实参按 `na.rm` 收一遍（不开就原样过）。 */
  const dropNa = (e) => (naRmOn()
    ? { kind: 'call', fn: { kind: 'name', name: useFn('r_drop_na') }, args: [e] }
    : e);

  /* `is.na` / `is.nan`：走那两格按指针的生成函数（载荷不能按值过，见 `PTR_REAL` 那段）。 */
  if (fn === 'is.na' || fn === 'is.nan') {
    if (n !== 1) throw new Error(`r->IR: ${fn}() 要正好一格实参（给了 ${n}）`);
    const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
    const name = useFn(fn === 'is.na' ? 'r_is_na' : 'r_is_nan');
    return { kind: 'call', fn: { kind: 'name', name }, args: [asReal(ev(0), t)] };
  }

  /* `is.finite` / `is.infinite`：C 回 int，包一格 `!= 0` 成布尔。 */
  if (fn !== null && PRED.has(fn)) {
    if (n !== 1) throw new Error(`r->IR: ${fn}() 要正好一格实参（给了 ${n}）`);
    const sym = PRED.get(fn);
    cabiUsed.add(sym);
    rmathSig(sym);
    const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
    return b('!=', { kind: 'ccall', sym, args: [asReal(ev(0), t)] }, { kind: 'int', value: 0 });
  }

  /* **R 自己的 C 先问一遍**（摆在 BUILTINS 之前）：这一族的答案不由我们给。 */
  if (fn !== null && RRAND.has(fn)) return randVecOf(fn, x, types);
  if ((fn === 'pmax' || fn === 'pmin') && n === 2
      && all.some((a) => a !== null && isVecTy(typeOfExpr(a, types)))) {
    /* 逐元素两头回收那一档（标量那边先摆成长度 1 的向量，回收那一层就只写一遍）。 */
    const asVec = (kk) => {
      const t = all[kk] === null ? REAL : typeOfExpr(all[kk], types);
      return isVecTy(t) ? ev(kk) : lglCall('r_vec1', asReal(ev(kk), t));
    };
    return lglCall(fn === 'pmax' ? 'r_pmax' : 'r_pmin', asVec(0), asVec(1));
  }
  if (fn !== null && RMATH.has(fn)) {
    const tys = all.map((a) => (a === null ? REAL : typeOfExpr(a, types)));
    const args = all.map((a, i) => ev(i));
    /* 第一格是向量就逐元素（`round(xs, 1)` / `dnorm(xs)`）：别的实参先存进临时量 ——
       循环里每一圈都要读，不能求好多遍。**只在第一格上逐元素** —— R 这一族其实是多头回收的
       （`round(xs, c(1,2))`），那要再摆一层，所以别的格也是向量时当场报，不假装。 */
    if (isVecTy(tys[0])) {
      const pre = [];
      const rest = args.slice(1).map((e, k) => {
        if (isVecTy(tys[k + 1])) {
          throw new Error(`r->IR: ${fn}() 只在第一格实参上逐元素（第 ${k + 2} 格也是向量 —— 多头回收还没接）`);
        }
        const nm = fresh('ma');
        pre.push({ kind: 'let', name: nm, type: REAL, init: asReal(e, tys[k + 1]) });
        return { kind: 'name', name: nm };
      });
      return vecMap1(args[0], (el) => rmathCall(fn, RMATH.get(fn), [el, ...rest], [REAL, ...rest.map(() => REAL)]), pre);
    }
    return rmathCall(fn, RMATH.get(fn), args, tys);
  }

  if (fn !== null && BUILTINS.has(fn)) {
    /**
     * **按字节办的那几格：串字面量里有非 ASCII 就当场报。**
     *
     * 方言的 `slen` / `ssub` / `supper` 数的都是**字节**，而 R 的 `nchar` / `substr` /
     * `toupper` 数的是**字符**（跟 locale 走）。量出来的（`Rscript`，2026-09-25）：
     * `nchar("héllo")` R 答 5、我们答 6；`substr("héllo", 1, 2)` R 出 `"hé"`、我们把那个
     * 两字节的字符切成半个。要接它得先给核心方言加"按码位走"那一层（见 SPEC 第四节第 12 条）。
     *
     * 这一格只拦得住"字面量里就有非 ASCII"那一半 —— 运行期才知道的拦不住。但那一半正是
     * 写例子时最容易撞上的，而静默答错最难查。`cat` / `paste` / `grepl` / `startsWith`
     * 这些**按字节办也对**（拼接与定串查找与码位无关），不在这张表里。
     */
    if (BYTEWISE.has(fn)) {
      for (const a of argsOf(x)) {
        if (a.value === null || !isList(a.value) || tag(a.value) !== 'str') continue;
        const s = String(leaf(kids(a.value)[0]));
        if (!/[^\u0000-\u007F]/.test(s)) continue;
        throw new Error(`r->IR: ${fn}() 收了一格**带非 ASCII 的串**（\`${s}\`）——`
          + ' 方言的 `slen` / `ssub` / `supper` 数的是**字节**，而 R 数的是字符'
          + '（`nchar("héllo")` 在 R 里是 5、按字节是 6）。要接它得先给核心方言加'
          + '"按码位走"那一层，见 ext/r/SPEC.md 第四节第 12 条');
      }
    }
    /* **命名实参先过一遍白名单**。为什么要这一格：认不出来的命名实参从前是被**静默丢掉**的
       —— `sum(x, na.rm = TRUE)` 里那个 `na.rm` 直接没了，于是答的是 `NA` 而 R 答 4。
       那是静默答错，比当场报难查得多（量出来的）。 */
    for (const a of argsOf(x)) {
      if (a.name === null) continue;
      /* **`list` / `switch` / `c` 不过这张表**：它们的命名实参是**数据**（键名 / 分支名 /
         元素名），不是开关 —— `list(n = 10)` 里那个 `n` 就是键名、`c(a = 1)` 里那个 `a`
         就是元素名，白名单在这三格没有意义。 */
      if (fn === 'list' || fn === 'switch' || fn === 'c') continue;
      const ok = NAMED_OK.get(fn);
      if (ok === undefined || !ok.has(a.name)) {
        throw new Error(`r->IR: ${fn}() 的命名实参 \`${a.name}=\` 还没接`
          + `（这一格接的是：${ok === undefined || ok.size === 0 ? '一个都没有' : [...ok].join(' / ')}）`);
      }
    }
    switch (fn) {
      case 'return':
        throw new Error('r->IR: `return()` 只能摆在语句位上（这儿在表达式里）');
      /* 名字那三格（见 `RNVEC`）。`names(v)` 读的是那个影子变量；`setNames` / `unname`
         这儿只管**值**那一条 —— 名字那一条由 `namesExprOf` 在赋值那一句上另发一条。 */
      case 'names': {
        if (n !== 1 || all[0] === null) throw new Error('r->IR: names() 要一格实参（管道位上还没接）');
        const ns = namesExprOf(all[0], types);
        if (ns === null) {
          throw new Error('r->IR: names() 只在**带名字的向量**上接（`c(a = 1, …)` / `setNames`）'
            + ' —— 这一格推不出名字来。list 上的 names() 要方言能枚举表里的键，'
            + '那一格还没有（见 ext/r/SPEC.md 第四节）');
        }
        return ns;
      }
      case 'unname': {
        if (n !== 1 || all[0] === null) throw new Error('r->IR: unname() 要一格实参（管道位上还没接）');
        return ev(0);
      }
      case 'setNames': {
        if (n !== 2) throw new Error(`r->IR: setNames() 要两格实参（给了 ${n}）`);
        return ev(0);
      }
      case 'length': {
        if (n !== 1) throw new Error('r->IR: length() 要一格实参');
        const t = all[0] === null ? INT : typeOfExpr(all[0], types);
        if (t.kind === 'map') return call1('dlen', ev(0));
        if (isStrVec(t)) return svLen(ev(0));
        return vecLen(ev(0));
      }
      case 'nchar': {
        if (n !== 1) throw new Error('r->IR: nchar() 要一格位置实参');
        /**
         * `type=` 只认 `"bytes"` 与 `"chars"`。这一档数的是**字节**，而"串字面量里有
         * 非 ASCII 就当场报"那一道闸门（`BYTEWISE`）已经在上头拦过 —— 所以在这一档
         * 能算出答案的地方，两种口径同解。`"width"` 不认（那要东亚宽度表）。
         */
        const tn = namedArg(x, 'type');
        if (tn !== undefined) {
          const lit = tag(tn) === 'str' ? String(nameOf(tn)) : null;
          if (lit !== 'bytes' && lit !== 'chars') {
            throw new Error('r->IR: nchar() 的 `type=` 只认 "bytes" 与 "chars"'
              + '（都按字节数 —— 非 ASCII 在上头就报了；`"width"` 要东亚宽度表，没接）');
          }
        }
        /* `nchar(字符向量)` 在 R 里逐元素出一条**数值**向量（两种存法之间过一趟）。 */
        if (all[0] !== null && isStrVec(typeOfExpr(all[0], types))) {
          return { kind: 'call', fn: { kind: 'name', name: useFn('r_nchar_v') }, args: [ev(0)] };
        }
        return call1('slen', ev(0));
      }
      case 'paste0': case 'paste': {
        /* `paste` 的默认 `sep` 是一个空格，`paste0` 是空串（R 的文档）。
           接起来的是**串**，所以数要先 `tostr` —— 与 awk 的 `cat` 那一格同一条。 */
        const sepNode = namedArg(x, 'sep');
        let sep = fn === 'paste0' ? '' : ' ';
        if (sepNode !== undefined) {
          if (tag(sepNode) !== 'str') throw new Error('r->IR: paste() 的 sep= 只接串字面量');
          sep = leaf(kids(sepNode)[0]);
        }
        if (n === 0) return { kind: 'string', value: '' };
        const colNode = namedArg(x, 'collapse');
        const colStr = colNode === undefined ? null : exprOf(colNode, types);
        if (colNode !== undefined && typeOfExpr(colNode, types).kind !== 'string') {
          throw new Error('r->IR: paste() 的 collapse= 要是一格串');
        }
        /* **有向量参与就逐元素**（`paste0("#", 1:3)` 出 `"#1" "#2" "#3"`）：结果长度取最长
           那格（标量算一格），短的从头再来（R 的回收规则）。**零长那一格收成空串**
           （`paste0("x", character(0))` 在 R 里是 `"x"`，不是 `character(0)`）——
           全都是零长时结果才是零长。数按 `as.character` 的 15 位转、逻辑印 `TRUE` / `FALSE`。
           `collapse=` 再把出来的那条连成一格串。 */
        const vecish = all.some((a) => a !== null && (isVecTy(typeOfExpr(a, types))
          || isStrVec(typeOfExpr(a, types))));
        if (vecish) {
          const stmts = [];
          let hasScalar = false;
          const parts0 = all.map((a, i) => {
            const t = a === null ? REAL : typeOfExpr(a, types);
            if (!isVecTy(t) && !isStrVec(t)) {
              hasScalar = true;
              const sn = fresh('ps');
              stmts.push({
                kind: 'let', name: sn, type: STR,
                init: a === null ? call1('tostr', extra) : asStr(a, types, 15),
              });
              return { vec: false, at: () => ({ kind: 'name', name: sn }) };
            }
            const vn = fresh('pv');
            const ln = fresh('pn');
            const vv = { kind: 'name', name: vn };
            stmts.push({ kind: 'let', name: vn, type: isStrVec(t) ? RSTRV : t, init: ev(i) });
            stmts.push({
              kind: 'let', name: ln, type: INT, init: isStrVec(t) ? svLen(vv) : vecLen(vv),
            });
            const len = { kind: 'name', name: ln };
            const at = (k) => {
              const idx = b('%', k, len);
              const one = (() => {
                if (isStrVec(t)) return svGet(vv, idx);
                const e = vecGet(vv, idx);
                if (isLglTy(t)) return lglCall('r_lgl_str', e);
                return {
                  kind: 'call',
                  fn: { kind: 'name', name: useFn(NUM_STR) },
                  args: [e, { kind: 'int', value: 15 }],
                };
              })();
              /* 零长那一格：既不能取元素也不能对 0 取模 —— 收成空串。 */
              return {
                kind: 'ternary',
                cond: b('==', len, { kind: 'int', value: 0 }),
                then: { kind: 'string', value: '' },
                else_: one,
              };
            };
            return { vec: true, len, at };
          });
          const mn = fresh('pm');
          const m = { kind: 'name', name: mn };
          stmts.push({ kind: 'let', name: mn, type: INT, init: { kind: 'int', value: hasScalar ? 1 : 0 } });
          for (const p of parts0.filter((q) => q.vec)) {
            stmts.push({
              kind: 'if', cond: b('>', p.len, m), then: [{ kind: 'assign', target: m, value: p.len }], else_: null,
            });
          }
          const on = fresh('po');
          const ov = { kind: 'name', name: on };
          stmts.push({ kind: 'let', name: on, type: RSTRV, init: call1('anew', tyArg(RSTRV), m) });
          const ix = fresh('pi');
          const iv = { kind: 'name', name: ix };
          const joined = parts0.map((p) => p.at(iv)).reduce((acc, p) => b('+', sep === ''
            ? acc : b('+', acc, { kind: 'string', value: sep }), p));
          stmts.push({
            kind: 'for',
            init: { kind: 'let', name: ix, type: INT, init: { kind: 'int', value: 0 } },
            cond: b('<', iv, m),
            post: { kind: 'assign', target: iv, value: b('+', iv, { kind: 'int', value: 1 }) },
            body: [{ kind: 'assign', target: svGet(ov, iv), value: joined }],
          });
          const value = colStr === null
            ? ov
            : { kind: 'call', fn: { kind: 'name', name: useFn('r_join_str') }, args: [ov, colStr] };
          return { kind: 'block-expr', stmts, value };
        }
        /* `paste` 的数走的是 **15 位有效数字**那一档（`as.character` 的口径），
           不是 `cat` 的 7 位 —— `paste(1/3)` 在 R 里是 `0.333333333333333`。 */
        const parts = all.map((a, i) => (a === null ? call1('tostr', extra) : asStr(a, types, 15)));
        return parts.reduce((acc, p) => b('+', sep === ''
          ? acc : b('+', acc, { kind: 'string', value: sep }), p));
      }
      case 'c': {
        /* `c(…)` 造一格向量，并且**摊平**实参里的向量（`c(xs, 4)` 是 R 的常用写法）。
           方言里"造"与"填"是两件事（`pnew` 只给槽数，写要 `pstore`，而那是语句），
           所以回一格 `block-expr`：先跑几句，再拿那格临时量当值。

           长度是**运行期**才知道的（向量那几格要问槽 0），所以先把向量实参存进临时量
           （一次求值），长度按"标量算 1、向量算它的长度"加起来，再拿一格写指针 `k` 填。 */
        /* `c()` 不带实参在 R 里是 `NULL`，而这一档没有 `NULL` —— 落成**零长向量**。
           这两者在最常用的那个写法上同解：`out <- c(); out <- c(out, i)` 那种攒结果的
           循环（`c(NULL, 1)` 与 `c(零长, 1)` 都是 `1`）。差别是 `is.null()`：
           R 对 `c()` 回 TRUE，我们这儿它是一条零长向量（明写在 SPEC）。 */
        if (n === 0) return lglCall('r_zeros', { kind: 'int', value: 0 });
        /* **有一格是串 → 整条是字符向量**（R 的收拢次序，数那几格按 `as.character` 的
           15 位有效数字转）。字符向量走 `(arr string)`，长度不必先算 —— `apush` 能现长。 */
        if (all.some((a) => {
          const t = a === null ? REAL : typeOfExpr(a, types);
          return t.kind === 'string' || isStrVec(t);
        })) {
          const tmp = fresh('sv');
          const outv = { kind: 'name', name: tmp };
          const stmts = [{
            kind: 'let', name: tmp, type: RSTRV, init: call1('anew', tyArg(RSTRV), { kind: 'int', value: 0 }),
          }];
          all.forEach((a, i) => {
            const t = a === null ? REAL : typeOfExpr(a, types);
            if (!isStrVec(t)) {
              stmts.push({
                kind: 'builtin-stmt',
                name: 'apush',
                args: [outv, a === null ? call1('tostr', extra) : asStr(a, types, 15)],
              });
              return;
            }
            /* 字符向量那一格要先存进临时量（长度与取值各读一次），再一格一格 push。 */
            const sn = fresh('cs');
            const sv = { kind: 'name', name: sn };
            const j = fresh('cj');
            const jv = { kind: 'name', name: j };
            stmts.push({ kind: 'let', name: sn, type: RSTRV, init: ev(i) });
            stmts.push({
              kind: 'for',
              init: { kind: 'let', name: j, type: INT, init: { kind: 'int', value: 0 } },
              cond: b('<', jv, svLen(sv)),
              post: { kind: 'assign', target: jv, value: b('+', jv, { kind: 'int', value: 1 }) },
              body: [{ kind: 'builtin-stmt', name: 'apush', args: [outv, svGet(sv, jv)] }],
            });
          });
          return { kind: 'block-expr', stmts, value: outv };
        }
        /* **一律 double** —— R 的 `c(10, 20, 30)` 是 double 向量（要 integer 得写 `10L`）。
           这一格原来按实参推 int/real，于是 `c(1, 2) + 0.5` 会在元素类型上打架。 */
        const pre = [];
        const parts = all.map((a, i) => {
          const t = a === null ? REAL : typeOfExpr(a, types);
          if (!isVecTy(t)) return { vec: false, value: asReal(ev(i), t) };
          const nm = fresh('ci');
          pre.push({ kind: 'let', name: nm, type: RVEC, init: ev(i) });
          return { vec: true, name: nm };
        });
        return numCatOf(pre, parts);
      }
      case 'list': {
        /* 空表的**值类型**这一层答不出来（R 里它就是空的），所以听上游那格 `want`——
           也就是"这个名字装什么"那张表推出来的（见 `inferTypes` 的 dicts 那一段）。 */
        const named = argsOf(x).filter((a) => a.name !== null);
        if (n === 0 && named.length === 0) {
          return call1('dnew', tyArg(want !== undefined && want.kind === 'map' ? want : dictOf(INT)));
        }
        /* `list(a = 1, tol = 1e-8)` —— **有名字的表**：造一格再一格一格 `dset`。
           方言里"造"与"写"是两件事（`dset` 是语句），所以回一格 `block-expr`。
           没名字的那几格（`list(1, 2)` 的位置实参）**当场报**：R 那儿它们是 1 / 2 号位，
           而这一层的表只有"按名字取"（`m[["k"]]`），假装接住就是静默答错。 */
        if (n !== 0) {
          throw new Error('r->IR: `list(…)` 里的**位置实参**还没接'
            + `（给了 ${n} 格没名字的）—— 这一层的表只有"按名字取"（\`m[["k"]]\`），`
            + ' R 那儿 `list(1, 2)` 是按位置存的，两回事');
        }
        const vt = want !== undefined && want.kind === 'map'
          ? want
          : typeOfCall(x, types);
        const tmp = fresh('lst');
        const tv = { kind: 'name', name: tmp };
        const stmts = [{ kind: 'let', name: tmp, type: vt, init: call1('dnew', tyArg(vt)) }];
        for (const a of named) {
          const at = typeOfExpr(a.value, types);
          const v = vt.value !== undefined && vt.value.kind === 'real' && at.kind === 'int'
            ? asReal(exprOf(a.value, types), at)
            : exprOf(a.value, types);
          stmts.push({
            kind: 'builtin-stmt',
            name: 'dset',
            args: [tv, { kind: 'string', value: a.name }, v],
          });
        }
        return { kind: 'block-expr', stmts, value: tv };
      }
      case 'is.null': {
        /* `is.null(m[["k"]])` 与 `is.null(m$k)` 是 R 里问"这张表有没有这个键"的写法
           （缺键回 NULL）。**只认这两种形状** —— 别的 `is.null` 当场报，不假装。 */
        if (n !== 1 || all[0] === null || !(tag(all[0]) === 'sub2' || isDollar(all[0]))) {
          throw new Error('r->IR: is.null() 只接 `is.null(x[["k"]])` 与 `is.null(x$k)` 两种形状'
            + '（问表里有没有这个键）');
        }
        if (isDollar(all[0])) {
          return {
            kind: 'unop',
            op: '!',
            operand: call1('dhas', exprOf(kids(all[0])[1], types),
              { kind: 'string', value: dollarKey(all[0]) }),
          };
        }
        const obj = kids(all[0])[0];
        const key = kids(kids(all[0])[1])[0];
        return { kind: 'unop', op: '!', operand: call1('dhas', exprOf(obj, types), exprOf(key, types)) };
      }
      case 'sqrt': case 'exp': case 'log': case 'log2': case 'log10':
      case 'floor': case 'ceiling':
      case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan':
      case 'sinh': case 'cosh': case 'tanh': {
        if (n !== 1) {
          throw new Error(`r->IR: ${fn}() 这一批只接一格实参（给了 ${n}）——`
            + ' 两格那一档（`log(x, base)`）要我们替它算，而"替它算"与"照它算"是两件事');
        }
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        const sym = { kind: 'strlit', value: LIBM.get(fn) };
        if (isVecTy(t)) return vecMap1(ev(0), (e) => call1('rmath', sym, e));
        return call1('rmath', sym, asReal(ev(0), t));
      }
      case 'numeric': case 'double': case 'integer': case 'logical': case 'character': {
        /* `numeric(n)` —— 一条 n 格的零向量（`numeric()` 是零长）。R 那边也认
           `numeric(length = n)`，所以那个名字也收。逻辑那一档零就是 FALSE，同一份内存。
           `character(n)` 是一条 n 格空串的字符向量（`(anew (arr string) n)` 出来就是空串）。 */
        const named = namedArg(x, 'length');
        let cnt = { kind: 'int', value: 0 };
        if (named !== undefined) cnt = asIntE(exprOf(named, types), typeOfExpr(named, types));
        else if (n >= 1) cnt = asIntE(ev(0), typeOfExpr(all[0], types));
        if (fn === 'character') return call1('anew', tyArg(RSTRV), cnt);
        return lglCall('r_zeros', cnt);
      }
      case 'sort': case 'cumsum': case 'prod': case 'range':
      case 'var': case 'sd': {
        /* `var(x, y)` 在 R 里**就是** `cov(x, y)`（`?var` 写着）—— 两格实参时转过去。 */
        if (fn === 'var' && n === 2) return callOf(cstCall('cov', all), types);
        /* `prod` 与 `range` 在 R 里也收**任意多格**（先摊平成一条向量，见 `numCatOf`）；
           别的几格只有一格向量。 */
        const many = fn === 'prod' || fn === 'range';
        if (n !== 1 && !many) {
          throw new Error(`r->IR: ${fn}() 只接一格向量实参（给了 ${n}）`);
        }
        if (n === 0) throw new Error(`r->IR: ${fn}() 一格实参都没给`);
        /**
         * `sort` 在**字符向量**上只接 `method = "radix"` 那一档：R 自己明说 radix 是在
         * **C locale** 下比的（`?sort`），量出来正是按字节 —— 那我们答得准。默认那一档
         * 按 locale 的排序规则（这台机器 `LC_COLLATE` 是 `zh_CN`，`sort(c("pear","apple",
         * "Banana"))` 出 `apple Banana pear`），要 ICU 那一套，照旧当场报。
         */
        if (fn === 'sort' && n >= 1 && all[0] !== null && isStrVec(typeOfExpr(all[0], types))) {
          const mn = namedArg(x, 'method');
          const ml = mn !== undefined && tag(mn) === 'str' ? String(nameOf(mn)) : null;
          if (ml !== 'radix') {
            throw new Error('r->IR: sort() 在字符向量上只接 `method = "radix"` —— R 的默认排序'
              + '按 locale 的排序规则（`Scollate`），那要 ICU 那一套；radix 是 R 自己明说'
              + '在 C locale 下比的那一档（按字节），这一档答得准');
          }
          const got0 = lglCall('r_sort_str', ev(0));
          return trueFlag(x, 'decreasing') ? lglCall('r_rev_str', got0) : got0;
        }
        const tyOf = (k) => {
          const t = all[k] === null ? REAL : typeOfExpr(all[k], types);
          if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap(fn));
          if (t.kind === 'map') throw new Error(`r->IR: ${fn}() 的实参是一张 list`);
          return t;
        };
        let src;
        if (n === 1) {
          const t = tyOf(0);
          /* `prod(5)` / `range(5)` 那种一格标量：摊成长度 1 的向量（R 也是这么答的）。 */
          if (!isVecTy(t)) {
            if (!many) throw new Error(`r->IR: ${fn}() 的实参不是向量（是 ${t.kind}）`);
            src = numCatOf([], [{ vec: false, value: asReal(ev(0), t) }]);
          } else src = ev(0);
        } else {
          const pre = [];
          const parts = all.map((a, k) => {
            const t = tyOf(k);
            if (!isVecTy(t)) return { vec: false, value: asReal(ev(k), t) };
            const nm = fresh('ai');
            pre.push({ kind: 'let', name: nm, type: RVEC, init: ev(k) });
            return { vec: true, name: nm };
          });
          src = numCatOf(pre, parts);
        }
        const got = lglCall(`r_${fn}`, dropNa(src));
        /* `sort(x, decreasing = TRUE)` —— 升着排完倒过来。相等的那几格分不出来
           （double 上全排序的结果是唯一的），所以与 R 逐字节一致。 */
        if (fn === 'sort' && trueFlag(x, 'decreasing')) return lglCall('r_rev', got);
        return got;
      }
      case 'head': case 'tail': {
        /* 第二格是"取几格"，缺省 6（R 的文档）；也认 `n=`。 */
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (!isStrVec(t) && !isVecTy(t)) throw new Error(`r->IR: ${fn}() 的第一格实参不是向量（是 ${t.kind}）`);
        const named = namedArg(x, 'n');
        let cnt = { kind: 'int', value: 6 };
        if (named !== undefined) cnt = asIntE(exprOf(named, types), typeOfExpr(named, types));
        else if (n >= 2) cnt = asIntE(ev(1), typeOfExpr(all[1], types));
        /* 字符向量那一侧**接了**：按下标挑，与 collation 无关（`sort` 那一格才要）。
           负的 `n`（R 里是"去掉末尾几格"）两边都还没接。 */
        if (isStrVec(t)) return lglCall(fn === 'head' ? 'r_head_str' : 'r_tail_str', ev(0), cnt);
        return lglCall(`r_${fn}`, ev(0), cnt);
      }
      case 'diff': {
        /**
         * `diff(x, lag)`：相隔 `lag` 格相减，长度是 `max(0, n - lag)`
         * （量出来 `diff(c(1,4), lag = 5)` 是 `numeric(0)`）。`differences=` 那一格
         * （差分几次）没接 —— 不在 `NAMED_OK` 里，所以当场报。
         */
        if (n < 1) throw new Error('r->IR: diff() 一格实参都没给');
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('diff'));
        if (!isVecTy(t)) throw new Error(`r->IR: diff() 的第一格实参不是向量（是 ${t.kind}）`);
        const named = namedArg(x, 'lag');
        let lag = { kind: 'int', value: 1 };
        if (named !== undefined) lag = asIntE(exprOf(named, types), typeOfExpr(named, types));
        else if (n >= 2) lag = asIntE(ev(1), typeOfExpr(all[1], types));
        return lglCall('r_diff', dropNa(ev(0)), lag);
      }
      case 'rank': {
        /** `rank(x)`：并列取**平均**（R 的默认 `ties.method = "average"`）。 */
        if (n !== 1) throw new Error(`r->IR: rank() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('rank'));
        return lglCall('r_rank', isVecTy(t) ? ev(0) : lglCall('r_vec1', asReal(ev(0), t)));
      }
      case 'bitwAnd': case 'bitwOr': case 'bitwXor': case 'bitwNot':
      case 'bitwShiftL': case 'bitwShiftR': {
        /**
         * 位运算那一族。**只接标量** —— R 那边它们是逐元素的（`bitwAnd(c(1L,2L), 3L)`），
         * 而那要再摆一层回收，所以向量进来当场报，不假装。
         *
         * 实参按 `as.integer` 收（`bitwAnd(12, 10)` 在 R 里也是 8）。
         */
        const one = fn === 'bitwNot';
        const want = one ? 1 : 2;
        if (n !== want) throw new Error(`r->IR: ${fn}() 要 ${want} 格实参（给了 ${n}）`);
        const gen = {
          bitwAnd: 'r_bit_and', bitwOr: 'r_bit_or', bitwXor: 'r_bit_xor',
          bitwNot: 'r_bit_not', bitwShiftL: 'r_bit_shl', bitwShiftR: 'r_bit_shr',
        }[fn];
        const arg = (k) => {
          const t = all[k] === null ? REAL : typeOfExpr(all[k], types);
          if (isVecTy(t)) throw new Error(`r->IR: ${fn}() 只接标量（第 ${k + 1} 格是向量 —— 逐元素那一层还没接）`);
          if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap(fn));
          return asIntE(ev(k), t);
        };
        return one ? lglCall(gen, arg(0)) : lglCall(gen, arg(0), arg(1));
      }
      case 'is.element': case 'setequal': case 'findInterval': {
        /**
         * 这三格都是"两条向量"：`is.element(el, set)` 与 `el %in% set` 是**同一格**
         * （R 的文档就是这么写的），所以走的也是同一对函数（`r_in_v` / `r_in1`）。
         */
        if (n !== 2) throw new Error(`r->IR: ${fn}() 要两格实参（给了 ${n}）`);
        const ts = [0, 1].map((k) => (all[k] === null ? REAL : typeOfExpr(all[k], types)));
        if (ts.some((t) => isStrVec(t) || t.kind === 'string')) throw new Error(strvGap(fn));
        const asVec = (k) => (isVecTy(ts[k]) ? ev(k) : lglCall('r_vec1', asReal(ev(k), ts[k])));
        if (fn === 'is.element') {
          return isVecTy(ts[0])
            ? lglCall('r_in_v', ev(0), asVec(1))
            : lglCall('r_in1', asReal(ev(0), ts[0]), asVec(1));
        }
        return lglCall(fn === 'setequal' ? 'r_setequal' : 'r_find_int', asVec(0), asVec(1));
      }
      case 'zapsmall': {
        /** `zapsmall(x, digits = 7)`（R 的默认 `getOption("digits")` 是 7）。 */
        if (n < 1) throw new Error('r->IR: zapsmall() 一格实参都没给');
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('zapsmall'));
        const dn = namedArg(x, 'digits');
        let dig = { kind: 'real', value: 7 };
        if (dn !== undefined) dig = asReal(exprOf(dn, types), typeOfExpr(dn, types));
        else if (n >= 2) dig = asReal(ev(1), typeOfExpr(all[1], types));
        return lglCall('r_zap', isVecTy(t) ? ev(0) : lglCall('r_vec1', asReal(ev(0), t)), dig);
      }
      case 'anyDuplicated': {
        /** `anyDuplicated(v)` —— 第一格重复元素的位置（1 起），没有回 0。串那一侧也接。 */
        if (n !== 1) throw new Error(`r->IR: anyDuplicated() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t)) return lglCall('r_any_dup_str', ev(0));
        if (t.kind === 'string') return lglCall('r_any_dup_str', lglCall('r_sv1', ev(0)));
        if (!isVecTy(t)) throw new Error(`r->IR: anyDuplicated() 的实参不是向量（是 ${t.kind}）`);
        return lglCall('r_any_dup', ev(0));
      }
      case 'quantile': {
        /**
         * `quantile(x, probs, names = FALSE)` —— **只接 `names = FALSE`**：R 默认回的是
         * 一条**带名字**的向量（`0% 25% 50% 75% 100%`），而这一档的名字是**跟着变量**走的
         * （见第二节"带名字的向量"），一格表达式交不出"值 + 名字"两样东西。
         * `names = FALSE` 那一档 R 回的就是裸向量，我们答得准。
         *
         * `type=` 只认 7（R 的默认）。缺失那一格：R 在 `na.rm = FALSE` 时**报错**
         * （不是悄悄丢掉），而我们的 `r_sort` 会丢 —— 所以没写 `na.rm = TRUE` 时
         * 先过一道 `r_any_na` 的运行期闸门。
         */
        if (n < 1) throw new Error('r->IR: quantile() 一格实参都没给');
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('quantile'));
        if (!isVecTy(t)) throw new Error(`r->IR: quantile() 的第一格实参不是向量（是 ${t.kind}）`);
        const nmArg = namedArg(x, 'names');
        if (nmArg === undefined || trueFlag(x, 'names')) {
          throw new Error('r->IR: quantile() 要明写 `names = FALSE` —— R 默认回的是一条**带名字**'
            + '的向量（`0% 25% …`），而这一档的名字跟着变量走（见 ext/r/SPEC.md 第二节），'
            + '一格表达式交不出"值 + 名字"两样东西');
        }
        const tyArg2 = namedArg(x, 'type');
        if (tyArg2 !== undefined) {
          const tl = tag(tyArg2) === 'num' ? String(leaf(kids(tyArg2)[0])) : null;
          if (tl !== '7' && tl !== '7L') {
            throw new Error('r->IR: quantile() 只接 `type = 7`（R 的默认那一种），别的九种没接');
          }
        }
        const pn = namedArg(x, 'probs');
        let probs = null;
        if (pn !== undefined) {
          const pt = typeOfExpr(pn, types);
          probs = isVecTy(pt) ? exprOf(pn, types) : lglCall('r_vec1', asReal(exprOf(pn, types), pt));
        } else if (n >= 2) {
          const pt = typeOfExpr(all[1], types);
          probs = isVecTy(pt) ? ev(1) : lglCall('r_vec1', asReal(ev(1), pt));
        } else probs = lglCall('r_qdef');
        /* `na.rm = TRUE` 先滤（`dropNa`）；没写就拦一道 —— R 那边是报错。 */
        const src = dropNa(ev(0));
        if (!naRmOn()) {
          return lglCall('r_quantile', lglCall('r_no_na', src), probs);
        }
        return lglCall('r_quantile', src, probs);
      }
      case 'cor': case 'cov': {
        /** `cor(x, y)` / `cov(x, y)` —— 两条一样长的数值向量（`var(x, y)` 也走这儿）。 */
        if (n !== 2) throw new Error(`r->IR: ${fn}() 要两格向量实参（给了 ${n}）`);
        const ts = [0, 1].map((k) => (all[k] === null ? REAL : typeOfExpr(all[k], types)));
        ts.forEach((t, k) => {
          if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap(fn));
          if (!isVecTy(t)) throw new Error(`r->IR: ${fn}() 的第 ${k + 1} 格实参不是向量（是 ${t.kind}）`);
        });
        return lglCall(fn === 'cor' ? 'r_cor' : 'r_cov', ev(0), ev(1));
      }
      case 'median': {
        /** `median(x)`：一格标量就是它自己（R 也这么答）；`na.rm=` 走公共的 `dropNa`。 */
        if (n !== 1) throw new Error(`r->IR: median() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('median'));
        if (!isVecTy(t)) return asReal(ev(0), t);
        return lglCall('r_median', dropNa(ev(0)));
      }
      case 'tabulate': {
        /**
         * `tabulate(bin, nbins)` —— 不给 `nbins` 时走 `r_tab_a`（默认长度 `max(1, bin)`，
         * 见那两格函数上的账）。字符向量那一侧没接。
         */
        if (n < 1) throw new Error('r->IR: tabulate() 至少要一格实参');
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('tabulate'));
        const vec = isVecTy(t) ? ev(0) : lglCall('r_vec1', asReal(ev(0), t));
        const named = namedArg(x, 'nbins');
        let kk = null;
        if (named !== undefined) kk = asIntE(exprOf(named, types), typeOfExpr(named, types));
        else if (n >= 2) kk = asIntE(ev(1), typeOfExpr(all[1], types));
        return kk === null ? lglCall('r_tab_a', vec) : lglCall('r_tabulate', vec, kk);
      }
      case 'anyNA': {
        /** `anyNA(x)`：一格标量也认（摊成长度 1 的向量）。串那一侧没有 `NA`，所以报。 */
        if (n !== 1) throw new Error(`r->IR: anyNA() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('anyNA'));
        return lglCall('r_any_na', isVecTy(t) ? ev(0) : lglCall('r_vec1', asReal(ev(0), t)));
      }
      case 'append': {
        /** `append(x, values, after)` —— 不给 `after` 就接到最后（走 `r_append_e`）。 */
        if (n < 2) throw new Error(`r->IR: append() 要两格实参（给了 ${n}）`);
        const t0 = all[0] === null ? REAL : typeOfExpr(all[0], types);
        const t1 = all[1] === null ? REAL : typeOfExpr(all[1], types);
        if (isStrVec(t0) || t0.kind === 'string' || isStrVec(t1) || t1.kind === 'string') {
          throw new Error(strvGap('append'));
        }
        if (isNamedTy(t0)) throw new Error('r->IR: append() 在带名字的向量上还没接（名字那一条要跟着插）');
        const av = isVecTy(t0) ? ev(0) : lglCall('r_vec1', asReal(ev(0), t0));
        const bv = isVecTy(t1) ? ev(1) : lglCall('r_vec1', asReal(ev(1), t1));
        const named = namedArg(x, 'after');
        let at = null;
        if (named !== undefined) at = asIntE(exprOf(named, types), typeOfExpr(named, types));
        else if (n >= 3) at = asIntE(ev(2), typeOfExpr(all[2], types));
        return at === null ? lglCall('r_append_e', av, bv) : lglCall('r_append', av, bv, at);
      }
      case 'replace': {
        /** `replace(x, list, values)` —— 与 `x[k] <- v` 同一套口径（见 `r_replace`）。 */
        if (n !== 3) throw new Error(`r->IR: replace() 要三格实参（给了 ${n}）`);
        const ts = [0, 1, 2].map((k) => (all[k] === null ? REAL : typeOfExpr(all[k], types)));
        if (ts.some((t) => isStrVec(t) || t.kind === 'string')) throw new Error(strvGap('replace'));
        if (isNamedTy(ts[0])) throw new Error('r->IR: replace() 在带名字的向量上还没接（名字那一条要跟着走）');
        const asVec = (k) => (isVecTy(ts[k]) ? ev(k) : lglCall('r_vec1', asReal(ev(k), ts[k])));
        return lglCall('r_replace', asVec(0), asVec(1), asVec(2));
      }
      case 'rep_len': {
        /** `rep_len(x, n)`：循环取到长度 `n`。字符向量那一侧还没接（存法不同）。 */
        if (n !== 2) throw new Error(`r->IR: rep_len() 要两格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap('rep_len'));
        const kk = asIntE(ev(1), typeOfExpr(all[1], types));
        /* 一格标量先摆成长度 1 的向量（`r_vec1` 是现成的那一格）。 */
        return lglCall('r_rep_len', isVecTy(t) ? ev(0) : lglCall('r_vec1', asReal(ev(0), t)), kk);
      }
      case 'rep': {
        /**
         * `rep(x, times, each)` —— 三格都接了（`length.out=` 没接）。
         *
         * R 的次序是**先 each 再 times**（量出来的）。串那一侧走另一格辅助函数
         * （`(arr string)` 与 `(ptr real)` 是两种存法）；一格串先摆成长度 1 的字符向量。
         */
        const named = namedArg(x, 'times');
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        let cnt = null;
        if (named !== undefined) cnt = asIntE(exprOf(named, types), typeOfExpr(named, types));
        else if (n >= 2) cnt = asIntE(ev(1), typeOfExpr(all[1], types));
        const eachNode = namedArg(x, 'each');
        const each = eachNode === undefined
          ? { kind: 'int', value: 1 }
          : asIntE(exprOf(eachNode, types), typeOfExpr(eachNode, types));
        if (cnt === null && eachNode === undefined) {
          throw new Error('r->IR: rep() 要 `times` 或者 `each`（`length.out=` 没接）');
        }
        if (cnt === null) cnt = { kind: 'int', value: 1 };
        if (isStrVec(t)) return lglCall('r_rep_str', ev(0), cnt, each);
        if (t.kind === 'string') {
          /* 一格串：现摆一条长度 1 的字符向量（`c(…)` 那一格也是这么攒的）。 */
          const tmp = fresh('rs');
          const tv = { kind: 'name', name: tmp };
          return {
            kind: 'block-expr',
            stmts: [
              { kind: 'let', name: tmp, type: RSTRV, init: call1('anew', tyArg(RSTRV), { kind: 'int', value: 1 }) },
              { kind: 'assign', target: svGet(tv, { kind: 'int', value: 0 }), value: ev(0) },
            ],
            value: lglCall('r_rep_str', tv, cnt, each),
          };
        }
        if (isVecTy(t)) return lglCall('r_rep_v', ev(0), cnt, each);
        /* 一格数：出 `times * each` 格（R 也是这么答的）。 */
        return lglCall('r_rep_s', asReal(ev(0), t), b('*', cnt, each));
      }
      case 'seq': {
        /* `seq(a, b)` 就是 `a:b`；带 `by` 的走那格生成出来的函数；`length.out=` 是另一格
           （步长 `(b-a)/(k-1)`，见 `r_seq_n`）。`seq(n)` 是 `1:n`（R 的文档）。 */
        const byNode = namedArg(x, 'by');
        const loNode = namedArg(x, 'length.out');
        const tys = all.map((a) => (a === null ? REAL : typeOfExpr(a, types)));
        if (loNode !== undefined) {
          if (n !== 2) {
            throw new Error(`r->IR: seq() 的 \`length.out=\` 这一档要两格位置实参（给了 ${n}）`);
          }
          return lglCall('r_seq_n', asReal(ev(0), tys[0]), asReal(ev(1), tys[1]),
            asIntE(exprOf(loNode, types), typeOfExpr(loNode, types)));
        }
        if (byNode === undefined && n === 1) {
          /* `seq(n)` = `1:n`（R 的文档里就是这一格）。 */
          return vecSeq({ kind: 'int', value: 1 }, INT, ev(0), tys[0]);
        }
        if (byNode === undefined && n === 2) {
          return vecSeq(ev(0), tys[0], ev(1), tys[1]);
        }
        const byE = byNode !== undefined
          ? asReal(exprOf(byNode, types), typeOfExpr(byNode, types))
          : (n === 3 ? asReal(ev(2), tys[2]) : null);
        if (byE === null || n < 2) {
          throw new Error(`r->IR: seq() 接的是 \`seq(n)\` / \`seq(a, b)\` / \`seq(a, b, by)\``
            + ` / \`seq(a, b, length.out = k)\`（给了 ${n} 格）`);
        }
        return lglCall('r_seq_by', asReal(ev(0), tys[0]), asReal(ev(1), tys[1]), byE);
      }
      case 'xor': {
        /* `xor` 是**逐元素**的（向量进向量出），所以一边是向量就走 `vecBin` 那一层。 */
        if (n !== 2) throw new Error(`r->IR: xor() 要两格实参（给了 ${n}）`);
        if (all[0] !== null && all[1] !== null) {
          const vx = vecBin('xor', all[0], all[1], types);
          if (vx !== null) return vx;
        }
        const t0 = all[0] === null ? REAL : typeOfExpr(all[0], types);
        const t1 = all[1] === null ? REAL : typeOfExpr(all[1], types);
        return lglCall('r_xor', asLgl(ev(0), t0), asLgl(ev(1), t1));
      }
      case 'isTRUE': case 'isFALSE': {
        /* 回的是**两态**：`isTRUE(NA)` 在 R 里是 `FALSE`（不是 `NA`）。 */
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isVecTy(t)) {
          throw new Error(`r->IR: ${fn}() 收一格向量 —— R 那一格回 FALSE（"长度不是 1"），`
            + ' 这一层还没有"问长度再定"的路，所以当场报');
        }
        return lglCall(fn === 'isTRUE' ? 'r_is_true' : 'r_is_false', asLgl(ev(0), t));
      }
      case 'ifelse': {
        /* `ifelse(test, yes, no)`：**结果的形状随 test**。test 是向量就逐格挑
           （`yes` / `no` 按回收取，标量先用 `r_vec1` 摆成长度 1 的向量）。 */
        if (n !== 3) throw new Error(`r->IR: ifelse() 要三格实参（给了 ${n}）`);
        const tys = all.map((a, k) => (a === null ? REAL : typeOfExpr(a, types)));
        /* **两支是串**那一档：R 出的是字符向量（`ifelse(v > 0, "pos", "neg")` 是常用写法）。
           `test` 是一格标量时就是一格三元；是向量时逐格挑（`r_ifelse_s`）。 */
        if (tys[1].kind === 'string' || tys[2].kind === 'string') {
          if (tys[1].kind !== 'string' || tys[2].kind !== 'string') {
            throw new Error('r->IR: ifelse() 的 `yes` / `no` 一格是串、一格不是 ——'
              + ' R 那儿会往串那边收，这一层的两种存法之间不自动过（写 `as.character(…)`）');
          }
          if (!isVecTy(tys[0])) {
            return { kind: 'ternary', cond: condOf(all[0], types), then: ev(1), else_: ev(2) };
          }
          return lglCall('r_ifelse_s', ev(0), ev(1), ev(2));
        }
        if (!isVecTy(tys[0])) {
          return lglCall('r_ifelse1', asLgl(ev(0), tys[0]),
            asReal(ev(1), tys[1]), asReal(ev(2), tys[2]));
        }
        const asVec = (k) => (isVecTy(tys[k]) ? ev(k) : lglCall('r_vec1', asReal(ev(k), tys[k])));
        return lglCall('r_ifelse', ev(0), asVec(1), asVec(2));
      }
      case 'any': case 'all': {
        /* `any` / `all` 收一格逻辑向量、回**三态标量**：
           `any` 见到 TRUE 就 TRUE，一个 TRUE 都没有但有 NA 就 NA，否则 FALSE；
           `all` 见到 FALSE 就 FALSE，一个 FALSE 都没有但有 NA 就 NA，否则 TRUE。
           标量那一档（`any(x > 2)` 里 x 是标量）R 也收，这儿就是那格值本身。 */
        if (n !== 1) {
          throw new Error(`r->IR: ${fn}() 这一批只接一格实参（给了 ${n}）——`
            + ' R 的 `any(a, b)` 要"任意多格实参"那一层，这一版没有');
        }
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (!isVecTy(t)) return asLgl(ev(0), t);
        return lglCall(fn === 'any' ? 'r_any' : 'r_all', dropNa(ev(0)));
      }
      case 'sum': case 'mean': case 'max': case 'min': {
        /**
         * **任意多格实参**（`max(1, 5, 3)` / `sum(xs, 10)`）—— 办法是先把那几格**摊平成
         * 一条向量**（`numCatOf`，与 `c(…)` 同一段代码），再走单实参那一格生成出来的函数。
         *
         * 为什么不是两两折（`max(a, b)` 那种）：缺失那一层会分叉。R 的口径是"有 `NA` 就
         * 是 `NA`、只有 `NaN` 才是 `NaN`"（`max(NaN, NA)` 也是 `NA`，量出来的），
         * 两两折要把这条规矩再写一遍；摊平之后 `r_max` 里那一份就是唯一的一份。
         *
         * **`mean` 不在这一档**：R 的 `mean(1, 2)` 答的是 `1`（第二格是 `trim=`），
         * 所以它多给一格就当场报，不假装。
         */
        if (n === 0) throw new Error(`r->IR: ${fn}() 一格实参都没给`);
        if (fn === 'mean' && n !== 1) {
          throw new Error('r->IR: mean() 只接一格实参 —— R 的 `mean(1, 2)` 答的是 `1`'
            + '（第二格是 `trim=`），这一层不假装接住');
        }
        const name = useFn({
          sum: 'r_sum', mean: 'r_mean', max: 'r_max', min: 'r_min',
        }[fn]);
        const one = (k) => {
          const t = all[k] === null ? REAL : typeOfExpr(all[k], types);
          if (isStrVec(t) || t.kind === 'string') throw new Error(strvGap(fn));
          if (t.kind === 'map') throw new Error(`r->IR: ${fn}() 的实参是一张 list`);
          return t;
        };
        if (n === 1) {
          const t = one(0);
          /* 一格标量（`sum(5)` / `max(x[1])`）在 R 里就是它自己（`mean` 也一样）。 */
          if (!isVecTy(t)) return asReal(ev(0), t);
          return { kind: 'call', fn: { kind: 'name', name }, args: [dropNa(ev(0))] };
        }
        const pre = [];
        const parts = all.map((a, k) => {
          const t = one(k);
          if (!isVecTy(t)) return { vec: false, value: asReal(ev(k), t) };
          const nm = fresh('ai');
          pre.push({ kind: 'let', name: nm, type: RVEC, init: ev(k) });
          return { vec: true, name: nm };
        });
        return { kind: 'call', fn: { kind: 'name', name }, args: [dropNa(numCatOf(pre, parts))] };
      }
      case 'which.max': case 'which.min': case 'unique': case 'duplicated':
      case 'order': case 'cumprod': case 'cummax': case 'cummin': {
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格向量实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        /* `unique` / `duplicated` 在**字符向量**上接了：只用"相等"，不要 collation。
           同一个 case 里的 `order` / `which.max` 那几格还是当场报（要排序）。 */
        if (isStrVec(t) && (fn === 'unique' || fn === 'duplicated')) {
          return lglCall(fn === 'unique' ? 'r_uniq_str' : 'r_dup_str', ev(0));
        }
        /* `order` 在字符向量上与 `sort` 同一条规矩：只接 `method = "radix"`（C locale）。 */
        if (isStrVec(t) && fn === 'order') {
          const mn2 = namedArg(x, 'method');
          const ml2 = mn2 !== undefined && tag(mn2) === 'str' ? String(nameOf(mn2)) : null;
          if (ml2 !== 'radix') {
            throw new Error('r->IR: order() 在字符向量上只接 `method = "radix"`（R 的默认那一档'
              + '按 locale 的排序规则，要 ICU）');
          }
          return lglCall('r_order_str', ev(0));
        }
        if (isStrVec(t)) throw new Error(strvGap(fn));
        if (!isVecTy(t)) throw new Error(`r->IR: ${fn}() 的实参不是向量（是 ${t.kind}）`);
        const gen = {
          'which.max': 'r_which_max', 'which.min': 'r_which_min', unique: 'r_unique',
          duplicated: 'r_dup', order: 'r_order', cumprod: 'r_cumprod',
          cummax: 'r_cummax', cummin: 'r_cummin',
        }[fn];
        return lglCall(gen, ev(0));
      }
      case 'match': case 'union': case 'intersect': case 'setdiff': {
        if (n !== 2) throw new Error(`r->IR: ${fn}() 要两格实参（给了 ${n}）`);
        const tys = all.map((a) => (a === null ? REAL : typeOfExpr(a, types)));
        /**
         * **串那一侧接了**（2026-09-26）：这四格只用"两个串是不是同一个"，而那是逐字节的、
         * 与 locale 无关 —— 与要 collation 的 `sort` / `order` 是两回事（见 SPEC 第四节
         * 第 12 条）。一格串也收（先摆成长度 1 的字符向量）。
         */
        if (tys.some((t) => isStrVec(t) || t.kind === 'string')) {
          if (tys.some((t) => !isStrVec(t) && t.kind !== 'string')) {
            throw new Error(`r->IR: ${fn}() 一边是串一边是数 —— R 那边会把数收成串（`
              + '`as.character`），这一档不替你收，写明白一点');
          }
          const sv = (kk) => (isStrVec(tys[kk]) ? ev(kk) : lglCall('r_sv1', ev(kk)));
          const gens = {
            match: 'r_match_str', union: 'r_union_str', intersect: 'r_isect_str', setdiff: 'r_sdiff_str',
          };
          return lglCall(gens[fn], sv(0), sv(1));
        }
        /* 标量也收（R 里 `match(2, t)` 是常用写法）—— 先摆成长度 1 的向量。 */
        const asVec = (kk) => (isVecTy(tys[kk]) ? ev(kk) : lglCall('r_vec1', asReal(ev(kk), tys[kk])));
        const gen = {
          match: 'r_match', union: 'r_union', intersect: 'r_intersect', setdiff: 'r_setdiff',
        }[fn];
        return lglCall(gen, asVec(0), asVec(1));
      }
      /**
       * `as.numeric` / `as.integer` —— **只在答得准的那几格上答**。
       *
       * 数值这一侧是现成的：向量本来就是 double（`as.numeric` 只是把"逻辑"那个记号摘掉）、
       * 标量在 int / real 之间走方言的 `toint` / `toreal`、两态逻辑落一格三元。
       *
       * **串那一侧当场报**：核心方言里没有"串 → 数"那一格算子（`toreal` 只在 int 与 real
       * 之间转），而自己写一圈按位累加，在 15 位有效数字或者 10^±22 之外与 `strtod` 的舍入
       * 对不上 —— 那是静默差最后几位，比当场报难查得多。
       */
      case 'as.integer': case 'as.numeric': {
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        const wantInt = fn === 'as.integer';
        if (t.kind === 'string' || isStrVec(t)) {
          throw new Error(`r->IR: ${fn}() 把**串**转成数还没接 —— 核心方言里没有"串 → 数"`
            + '那一格算子，而自己写一圈按位累加在 15 位有效数字之外与 `strtod` 的舍入对不上'
            + '（那是静默差最后几位）。见 ext/r/SPEC.md 第四节');
        }
        if (t.kind === 'map') throw new Error(`r->IR: ${fn}() 的实参是一张 list`);
        if (isVecTy(t)) {
          /* 向量：R 出的还是一条向量。`as.integer` 要逐元素**朝零截**（缺失原样留着 ——
             这一档的"整数向量"底下还是 double，所以 `NA` 跟得住，与 R 印出来一样）。 */
          return wantInt ? lglCall('r_as_int_v', ev(0)) : ev(0);
        }
        if (t.kind === 'bool') {
          const one = wantInt ? { kind: 'int', value: 1 } : { kind: 'real', value: 1 };
          const zero = wantInt ? { kind: 'int', value: 0 } : { kind: 'real', value: 0 };
          return { kind: 'ternary', cond: ev(0), then: one, else_: zero };
        }
        if (isLgl1(t)) {
          /* 三态逻辑标量：`as.numeric` 就是它自己（1 / 0 / NA 都是 double）。
             `as.integer` 当场报 —— R 那儿答 `NA_integer_`，而这一档没有它（第四节第 11 条）。 */
          if (!wantInt) return ev(0);
          throw new Error('r->IR: as.integer() 收了一格**三态逻辑**（`x > 2` 那种）——'
            + ' R 那儿 `NA` 转出来是 `NA_integer_`，而这一档没有带缺失的整数'
            + '（见 ext/r/SPEC.md 第四节第 11 条）。要数就写 `as.numeric(…)`');
        }
        if (wantInt) return t.kind === 'int' ? ev(0) : call1('toint', ev(0));
        return t.kind === 'real' ? ev(0) : call1('toreal', ev(0));
      }
      /* `as.character(x)` 与 `cat(x)` 是**两套位数**：前者 15 位有效数字
         （`0.333333333333333`），后者 7 位（`0.3333333`）。所以这一格走 `asStr(…, 15)`，
         不是 `tostr`（那一格是方言自己的浮点文本，与 R 的挑法无关）。 */
      case 'as.character': {
        if (n !== 1 || all[0] === null) return call1('tostr', ev(0));
        /**
         * 向量那一档出**一条字符向量**（15 位有效数字 —— `coerce.c` 的口径）。
         *
         * **里头有 `NA` 就当场报**：R 那边 `as.character(c(1, NA))` 是 `[1] "1" NA`，
         * 那个 `NA` 印出来**不带引号**（是 `NA_character_`，不是串 `"NA"`），而这一档
         * 没有带缺失的串（第四节第 11 条）。印成 `"NA"` 就是静默差两个引号，所以
         * 那一格在**运行期**停下来 —— 从前是整格不接（连 `as.character(c(1,2))` 都报），
         * 现在只拦真碰上缺失的那一趟。
         */
        const t0 = typeOfExpr(all[0], types);
        if (isStrVec(t0)) return ev(0);
        if (isVecTy(t0)) return lglCall(isLglTy(t0) ? 'r_as_str_lv' : 'r_as_str_v', ev(0));
        return asStr(all[0], types, 15);
      }
      case 'toupper': case 'tolower': case 'casefold': {
        /* `casefold(x, upper = FALSE)` 在 R 里就是这两格的别名（`?casefold`：
           "for compatibility with S"）—— 所以在这儿收拢成同一段，不另写一份。 */
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格位置实参（给了 ${n}）`);
        const t = all[0] === null ? STR : typeOfExpr(all[0], types);
        const up = fn === 'toupper' || (fn === 'casefold' && trueFlag(x, 'upper'));
        /* 字符向量那一档逐元素出一条新的字符向量。 */
        if (isStrVec(t)) {
          return {
            kind: 'call',
            fn: { kind: 'name', name: useFn(up ? 'r_upper_v' : 'r_lower_v') },
            args: [ev(0)],
          };
        }
        if (up) return call1('supper', ev(0));
        return { kind: 'call', fn: { kind: 'name', name: useFn('r_lower') }, args: [ev(0)] };
      }
      case 'format': {
        /**
         * `format(x, nsmall =, width =)` —— **只接标量**。
         *
         * 向量那一档没接：R 会给一条向量算一套**共用的宽与共用的小数位**
         * （量出来 `format(c(1,10,100))` 是 `"  1" " 10" "100"`、
         * `format(c(1.5,10))` 是 `" 1.5" "10.0"`），而那一套正是 `printFnDecl` 里
         * 印向量那一大段在算的东西 —— 接它是把那一段改成"也能交出一条字符向量"，
         * 那是另一刀（那段代码是逐字节判据的要害，不顺手改）。
         */
        if (n !== 1) throw new Error(`r->IR: format() 要一格位置实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (isVecTy(t) || isStrVec(t) || t.kind === 'map') {
          throw new Error('r->IR: format() 只接标量 —— 向量那一档 R 会算一套**共用的**宽与小数位'
            + '（`format(c(1,10,100))` 是 `"  1" " 10" "100"`），那一套在 `printFnDecl` 里，'
            + '交出字符向量是另一刀');
        }
        const named = (k) => {
          const nd = namedArg(x, k);
          return nd === undefined ? { kind: 'int', value: 0 } : asIntE(exprOf(nd, types), typeOfExpr(nd, types));
        };
        const w = named('width');
        /* 串**左对齐**、真假与数**右对齐**（R 的口径，量出来 `format("a", width=4)` 是 `"a   "`）。 */
        if (t.kind === 'string') {
          if (namedArg(x, 'nsmall') !== undefined) {
            throw new Error('r->IR: format() 的 `nsmall=` 只对数有意义（给的是一格串）');
          }
          return lglCall('r_padr', ev(0), w);
        }
        if (t.kind === 'bool' || isLgl1(t)) {
          if (namedArg(x, 'nsmall') !== undefined) {
            throw new Error('r->IR: format() 的 `nsmall=` 只对数有意义（给的是真假）');
          }
          return lglCall('r_padl', asStr(all[0], types, 7), w);
        }
        return lglCall('r_format1', asReal(ev(0), t), named('nsmall'), w);
      }
      case 'Sys.getenv': {
        /**
         * `Sys.getenv(name)` —— 方言的 `(getenv E)` 就是它，没设的回**空串**
         * （两边同解：R 的 `Sys.getenv` 没设也回 `""`，量过）。
         *
         * 不带实参那一档没接（R 回的是一整条带名字的字符向量），`unset=` 也没接。
         */
        if (n !== 1) throw new Error(`r->IR: Sys.getenv() 这一档要一格实参（给了 ${n}）——`
          + ' 不带实参时 R 回的是一整条带名字的字符向量，这一层没有');
        const t = all[0] === null ? STR : typeOfExpr(all[0], types);
        if (t.kind !== 'string') throw new Error(`r->IR: Sys.getenv() 的实参要是一格串（是 ${t.kind}）`);
        return call1('getenv', ev(0));
      }
      case 'is.function': {
        /**
         * `is.function(f)` —— 这一档里"是不是函数"**编译期就知道**：名字在这一段定义过的
         * 函数表（`fnDefs`）里、或者是内建/nmath 那两张表里，就是 TRUE，别的是 FALSE。
         *
         * 与 `is.numeric` / `is.character` 那三问同一条路（文件头第 4 条：类型是推出来的，
         * 所以那几问是编译期常量）。
         */
        if (n !== 1) throw new Error(`r->IR: is.function() 要一格实参（给了 ${n}）`);
        const a0 = all[0];
        const known = a0 !== null && isList(a0) && tag(a0) === 'sym'
          && (fnDefs.has(mangle(nameOf(a0))) || BUILTINS.has(String(nameOf(a0))) || RMATH.has(String(nameOf(a0))));
        /* 就地写的匿名函数也是函数（`is.function(function(x) x)`）。 */
        const lam = a0 !== null && isList(a0) && tag(a0) === 'fn';
        return { kind: 'bool', value: known || lam };
      }
      case 'strrep': {
        /**
         * `strrep(x, times)`：接起来 `times` 遍。方言的 `(srep S N)` 就是它 ——
         * 字符向量那一档逐元素（次数只接一格标量：R 那边两边都回收，那要再摆一层）。
         */
        if (n !== 2) throw new Error(`r->IR: strrep() 要两格实参（给了 ${n}）`);
        const t = all[0] === null ? STR : typeOfExpr(all[0], types);
        const kt = all[1] === null ? INT : typeOfExpr(all[1], types);
        if (isVecTy(kt)) throw new Error('r->IR: strrep() 的次数只接一格标量（R 那边两边都回收，那一层还没接）');
        const kk = asIntE(ev(1), kt);
        if (isStrVec(t)) return lglCall('r_strrep_v', ev(0), kk);
        if (t.kind !== 'string') throw new Error(`r->IR: strrep() 的第一格实参不是串（是 ${t.kind}）`);
        return call1('srep', ev(0), kk);
      }
      case 'substr': {
        /* R 的 `substr(s, start, stop)` 是**1 起、两端都含**，而且越界是**截断**
           （方言的 `(ssub S I N)` 是 0 起 + 长度，越界当场报）—— 所以走生成出来的那格函数。
           字符向量那一档逐元素（另一格辅助函数，`(arr string)` 与串是两种存法）。 */
        if (n !== 3) throw new Error(`r->IR: substr() 要三格实参（给了 ${n}）`);
        const vec = all[0] !== null && isStrVec(typeOfExpr(all[0], types));
        return lglCall(vec ? 'r_substr_v' : 'r_substr', ev(0),
          asIntE(ev(1), typeOfExpr(all[1], types)), asIntE(ev(2), typeOfExpr(all[2], types)));
      }
      case 'substring': {
        /* `substring(s, first, last = 1000000L)` —— 与 `substr` 同一格函数，只是 `last`
           可以不给（R 的默认就是那个大数）。字符向量那一档也逐元素。 */
        if (n < 2 || n > 3) throw new Error(`r->IR: substring() 接两格或三格实参（给了 ${n}）`);
        const last = n === 3
          ? asIntE(ev(2), typeOfExpr(all[2], types))
          : { kind: 'int', value: 1000000 };
        const vec = all[0] !== null && isStrVec(typeOfExpr(all[0], types));
        return lglCall(vec ? 'r_substr_v' : 'r_substr', ev(0),
          asIntE(ev(1), typeOfExpr(all[1], types)), last);
      }
      case 'trimws': {
        /**
         * `trimws(x, which)` —— `which` 是 `"both"`（默认）/ `"left"` / `"right"`，
         * **只接串字面量**（这一档没有"运行期挑一个分支"的必要，而表外的值在 R 里也是报错）。
         */
        if (n !== 1) throw new Error(`r->IR: trimws() 要一格位置实参（给了 ${n}）`);
        const vec = all[0] !== null && isStrVec(typeOfExpr(all[0], types));
        const wn = namedArg(x, 'which');
        let mode = 0;
        if (wn !== undefined) {
          const lit = tag(wn) === 'str' ? String(nameOf(wn)) : null;
          if (lit === null) throw new Error("r->IR: trimws() 的 `which=` 只接串字面量（\"both\" / \"left\" / \"right\"）");
          const tb = { both: 0, left: 1, right: 2 };
          if (!Object.prototype.hasOwnProperty.call(tb, lit)) {
            throw new Error(`r->IR: trimws() 的 \`which = "${lit}"\` 不认（只有 "both" / "left" / "right"）`);
          }
          mode = tb[lit];
        }
        return lglCall(vec ? 'r_trim_v' : 'r_trim', ev(0), { kind: 'int', value: mode });
      }
      case 'chartr': {
        /**
         * `chartr(old, new, x)`：`old` 里第 k 个字符换成 `new` 里第 k 个（表外的原样留下）。
         * 两张表是串，`x` 可以是串或者字符向量。**按字节办** —— 见 `BYTEWISE` 那张表。
         */
        if (n !== 3) throw new Error(`r->IR: chartr() 要三格实参（给了 ${n}）`);
        const ts = [0, 1, 2].map((k) => (all[k] === null ? STR : typeOfExpr(all[k], types)));
        if (ts[0].kind !== 'string' || ts[1].kind !== 'string') {
          throw new Error('r->IR: chartr() 的前两格实参要是串（`old` / `new` 是字符表）');
        }
        if (isStrVec(ts[2])) return lglCall('r_chartr_v', ev(2), ev(0), ev(1));
        if (ts[2].kind !== 'string') throw new Error(`r->IR: chartr() 的第三格实参不是串（是 ${ts[2].kind}）`);
        return lglCall('r_chartr', ev(0), ev(1), ev(2));
      }
      case 'unlist': {
        /* `unlist(strsplit(s, sep))` 与 `unlist(lapply(v, f))` —— 前者与 `[[1]]` 同解，
           后者与 `sapply` 同解（R 里 `sapply` 就是"`lapply` 之后能简化就简化"）。 */
        if (n === 1 && all[0] !== null && isSplitCall(all[0])) return splitOf(all[0], types);
        if (n === 1 && all[0] !== null && isApplyCall(all[0], 'lapply')) {
          return applyOf('lapply', all[0], types);
        }
        throw new Error('r->IR: unlist() 只接 `unlist(strsplit(s, sep))` 与'
          + ' `unlist(lapply(v, function(x) …))` 这两种形状（这一层没有"表里装向量"）');
      }
      case 'sapply': case 'vapply': case 'Reduce': case 'Filter': case 'mapply':
        return applyOf(fn, x, types);
      case 'lapply':
        throw new Error('r->IR: lapply(…) 要写成 `unlist(lapply(…))` 或直接用 `sapply(…)`'
          + ' —— R 里它回的是一张表，而这一层没有"表里装向量"');
      case 'strsplit':
        throw new Error('r->IR: strsplit(…) 要写成 `strsplit(s, sep)[[1]]` 或'
          + ' `unlist(strsplit(s, sep))` —— R 那边它回的是一张**表**，而这一层没有"表里装向量"');
      /* 找与换那一族（见 `findOf`）—— pattern 只认串字面量。 */
      case 'grepl': case 'grep': case 'sub': case 'gsub':
        return findOf(fn, x, types);
      case 'is.character': case 'is.numeric': case 'is.logical': {
        /* 类型在这一层是**推出来的**（方言那侧没有运行期的类型标签），所以这三问的答案是
           编译期常量。R 的口径：`is.numeric(TRUE)` 是 FALSE、`is.numeric(1L)` 是 TRUE。 */
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        const lgl = t.kind === 'bool' || isLgl1(t) || isLglTy(t);
        const val = fn === 'is.character' ? (t.kind === 'string' || isStrVec(t))
          : (fn === 'is.logical' ? lgl
            : (!lgl && (t.kind === 'int' || t.kind === 'real' || isVecTy(t))));
        return { kind: 'bool', value: val };
      }
      case 'startsWith': case 'endsWith': {
        if (n !== 2) throw new Error(`r->IR: ${fn}() 要两格实参（给了 ${n}）`);
        const t0 = all[0] === null ? STR : typeOfExpr(all[0], types);
        const t1 = all[1] === null ? STR : typeOfExpr(all[1], types);
        if (isStrVec(t1)) {
          throw new Error(`r->IR: ${fn}() 的第二格实参是一条字符向量 ——`
            + ' R 那儿两边都回收，这一层只接"一格定串"（那一半写个循环）');
        }
        if (isStrVec(t0)) return lglCall(fn === 'startsWith' ? 'r_starts_v' : 'r_ends_v', ev(0), ev(1));
        return lglCall(fn === 'startsWith' ? 'r_starts' : 'r_ends', ev(0), ev(1));
      }
      case 'sprintf': return sprintfOf(x, types);
      case 'abs': {
        const t = all[0] === null ? INT : typeOfExpr(all[0], types);
        if (isVecTy(t)) return vecMap1(ev(0), (e) => call1('rmath', { kind: 'strlit', value: 'fabs' }, e));
        if (t.kind === 'real') return call1('rmath', { kind: 'strlit', value: 'fabs' }, ev(0));
        /* 整数上的 `abs`：方言里没有这一格算子，落成一格三元 */
        return { kind: 'ternary', cond: b('<', ev(0), { kind: 'int', value: 0 }), then: { kind: 'unop', op: '-', operand: ev(0) }, else_: ev(0) };
      }
      case 'rev': case 'seq_along': case 'which': {
        if (n !== 1) throw new Error(`r->IR: ${fn}() 要一格实参（给了 ${n}）`);
        const t = all[0] === null ? INT : typeOfExpr(all[0], types);
        /* 字符向量那两格：`rev` 倒着抄一遍，`seq_along` 出 `1 … alen` 一条数值向量。 */
        if (isStrVec(t)) {
          if (fn === 'rev') {
            return { kind: 'call', fn: { kind: 'name', name: useFn('r_rev_str') }, args: [ev(0)] };
          }
          if (fn === 'seq_along') {
            return { kind: 'call', fn: { kind: 'name', name: useFn('r_iota') }, args: [svLen(ev(0))] };
          }
          throw new Error('r->IR: which() 的实参要是逻辑向量（字符向量没有"真假"这一层）');
        }
        if (!isVecTy(t)) throw new Error(`r->IR: ${fn}() 的实参不是向量（是 ${t.kind}）`);
        if (fn === 'which' && !isLglTy(t)) {
          throw new Error('r->IR: which() 的实参要是逻辑向量（R 里它就是"哪几格为真"）');
        }
        return { kind: 'call', fn: { kind: 'name', name: useFn(`r_${fn}`) }, args: [ev(0)] };
      }
      case 'cat':
        throw new Error('r->IR: `cat()` 只能摆在语句位上（这儿在表达式里）');
      case 'print':
        throw new Error('r->IR: `print()` 只能摆在语句位上（R 里它回的是"不可见的那格值"，'
          + ' 而这一档没有"可见性"这一层）');
      case 'set.seed':
        throw new Error('r->IR: `set.seed()` 只能摆在语句位上（它回的是"不可见的 NULL"）');
      case 'stop': case 'stopifnot':
        throw new Error(`r->IR: \`${fn}()\` 只能摆在语句位上（它落的是方言的 \`(fail …)\`，那是一条语句）`);
      case 'switch': return switchOf(x, types, false);
      case 'sample': {
        /* R 的 `sample`：**回的是下标**（`sample.int`），向量那一档就是拿下标去挑。
           不放回那一条照 `do_sample` 的算法（每次抽一格、把末尾那格填进空位）——
           于是与 R 逐位相同（R >= 3.6 的 `R_unif_index` 是拒绝采样）。
           `replace=` / `prob=` 没接：那是另外两个算法（Walker 别名法那一套）。 */
        if (namedArg(x, 'replace') !== undefined || namedArg(x, 'prob') !== undefined) {
          throw new Error('r->IR: sample() 的 `replace=` / `prob=` 没接 —— 那是另外两条算法');
        }
        if (n < 1 || n > 2) throw new Error(`r->IR: sample() 接一格或两格实参（给了 ${n}）`);
        const t = all[0] === null ? REAL : typeOfExpr(all[0], types);
        if (!isVecTy(t)) {
          const nOf = asIntE(ev(0), t);
          const k = n === 2 ? asIntE(ev(1), typeOfExpr(all[1], types)) : nOf;
          return lglCall('r_sample_i', nOf, k);
        }
        /* 向量那一档要把它存进临时量（长度与取值各读一次） */
        const vn = fresh('sv');
        const vr = { kind: 'name', name: vn };
        const k2 = n === 2 ? asIntE(ev(1), typeOfExpr(all[1], types)) : vecLen(vr);
        return {
          kind: 'block-expr',
          stmts: [{ kind: 'let', name: vn, type: t, init: ev(0) }],
          value: lglCall('r_vec_pick', vr, lglCall('r_sample_i', vecLen(vr), k2)),
        };
      }
      /* `invisible(x)` 就是 x 本身 —— 差别只在"顶层要不要印"，而那一问在 `topStmtOf` 里。 */
      case 'invisible': {
        if (n !== 1) throw new Error(`r->IR: invisible() 要正好一格实参（给了 ${n}）`);
        return ev(0);
      }
      case 'seq_len': {
        /* `for (v in seq_len(n))` 那一档在 `forOf` 里落成计数循环（不造向量）；
           当**值**用时造一条 `1 … n`（`r_iota`），`seq_len(0)` 是零长。 */
        if (n !== 1) throw new Error(`r->IR: seq_len() 要一格实参（给了 ${n}）`);
        return lglCall('r_iota', asIntE(ev(0), all[0] === null ? INT : typeOfExpr(all[0], types)));
      }
      default:
        throw new Error(`r->IR: 内建 ${fn} 在表里却没有落法 —— BUILTINS 与这个 switch 走散了`);
    }
  }
  if (fn === null) throw new Error('r->IR: 只接"名字 + 实参"那种调用（函数值还没接）');
  /* 用户函数：形参类型是 `inferFns()` 推出来的，所以实参这一侧要按它对齐
     （`half(3)` 里 `x` 已经定成 real，那个 `3` 得先加宽 —— 方言那层不隐式转），
     而缺的那几格在这儿填默认值（见 `fnDefs` 那段账）。 */
  const ptys = fnParams.get(mangle(fn));
  const pnames = fnFormals.get(mangle(fn));
  if (pnames === undefined) {
    /* **不认识的名字当场报，而且报 R 的那个名字。**
       从前这儿是"照原样发，让链接期去说" —— 于是 `data.frame(…)` 报的是
       `未声明的函数 'data_frame'`（mangle 之后的名字，源码里根本没有这个词），
       `library(ggplot2)` 报的是 `未声明的函数 'library'` 加一句"`ggplot2` 没声明"。
       两条都让人以为是链接出了问题，而实情是**这一格还没接**。 */
    throw new Error(`r->IR: R 的 \`${fn}()\` 还没接 —— ${gapHint(fn)}`);
  }
  const bound = bindArgs(fn, pnames, fnDefs.get(mangle(fn)) ?? [], x, extra !== undefined);
  return {
    kind: 'call',
    fn: { kind: 'name', name: mangle(fn) },
    args: bound.map((node, i) => {
      const e = node === null ? extra : exprOf(node, types);
      const pt = ptys === undefined ? undefined : ptys[i];
      if (pt === undefined) return e;
      const at = node === null ? undefined : typeOfExpr(node, types);
      if (pt.kind === 'real' && at !== undefined && (at.kind === 'int' || at.kind === 'bool')) {
        return asReal(e, at);
      }
      return e;
    }),
  };
}

/**
 * `print(x)` / **顶层自动印** → 一串写。
 *
 * 与 `cat` 的差别是 R 自己的：`cat` 把值连成一串文本、不带换行也不带标号；
 * `print` 印的是"这个对象长什么样"——`[1]` 那个标号、一整条向量共用的宽度、80 列换行、
 * 串带引号。向量那一档在 `printFnDecl` 里（要一整趟取极值）；标量这一档宽度就是它自己
 * 那串的长度，所以直接写。
 */
function printValStmt(node, types) {
  const t = typeOfExpr(node, types);
  const wr = (s) => ({ kind: 'builtin-stmt', name: 'write', args: [s] });
  /* **带名字的向量**：名字一行、值一行，两行共用一个宽（见 `r_print_named`）。 */
  if (isNamedTy(t)) {
    if (isLglTy(t)) {
      throw new Error('r->IR: 印一条**带名字的逻辑向量**（`v > 1` 那种）还没接'
        + ' —— R 会把名字带过去，这一档只让数值那一条带。要印不带名字的写 `unname(v > 1)`');
    }
    const ns = namesExprOf(node, types);
    if (ns === null) {
      throw new Error('r->IR: print() 这一格带名字的向量印不出名字来 —— 名字那一条跟丢了'
        + '（名字是**跟着变量**走的，见 ext/r/SPEC.md 第二节）。'
        + 'R 里 `sort` / `rev` / `head` / `cumsum` / `abs` / `v[v > 1]` 这些都把名字带过去，'
        + '这一档带不了 —— 要印不带名字的那一条就写 `unname(…)`');
    }
    return {
      kind: 'expr-stmt',
      expr: lglCall('r_print_named', exprOf(node, types), ns, { kind: 'string', value: zeroName(t) }),
    };
  }
  /* `v["a"]` / `v[1]` —— R 的**单**方括号取一格出来名字也跟着（两行版式），`v[["a"]]` 不带。
     值那一条已经是一格标量了，所以这儿现摆一条长度 1 的向量与一条长度 1 的名字。 */
  if (tag(node) === 'sub1' && isNamedTy(typeOfExpr(kids(node)[0], types))) {
    const keys = kids(node).slice(1).map((a) => kids(a)[0]).filter((k) => k !== undefined);
    if (keys.length !== 1) throw new Error('r->IR: 多维下标（x[i, j]）还没接');
    const ns = namesExprOf(kids(node)[0], types);
    const kt = typeOfExpr(keys[0], types);
    const nn = fresh('p1n');
    /* 下标是串就在名字那条里找（找不到 R 印 `<NA>`，`r_nm_at` 就答这个）；
       下标是数就直接取那一格（`v[1]` 的名字是 `names(v)[1]`）。 */
    const one = kt.kind === 'string'
      ? lglCall('r_nm_at', ns, exprOf(keys[0], types))
      : svGet(ns, zeroBased(exprOf(keys[0], types), kt));
    return {
      kind: 'block',
      stmts: [
        {
          kind: 'let', name: nn, type: RSTRV,
          init: call1('anew', tyArg(RSTRV), { kind: 'int', value: 1 }),
        },
        {
          kind: 'assign',
          target: { kind: 'index', obj: { kind: 'name', name: nn }, index: { kind: 'int', value: 0 } },
          value: one,
        },
        {
          kind: 'expr-stmt',
          expr: lglCall('r_print_named', lglCall('r_vec1', exprOf(node, types)),
            { kind: 'name', name: nn },
            { kind: 'string', value: zeroName(typeOfExpr(kids(node)[0], types)) }),
        },
      ],
    };
  }
  if (isVecTy(t)) {
    return {
      kind: 'expr-stmt',
      expr: isLglTy(t)
        ? lglCall('r_print_lgl', exprOf(node, types))
        : lglCall('r_print_num', exprOf(node, types), { kind: 'string', value: zeroName(t) }),
    };
  }
  /* 字符向量：带引号、**左对齐**、共用一套宽（见 `strvFnDecl`）。 */
  if (isStrVec(t)) {
    return {
      kind: 'expr-stmt',
      expr: { kind: 'call', fn: { kind: 'name', name: useFn('r_print_str') }, args: [exprOf(node, types)] },
    };
  }
  if (t.kind === 'map') throw new Error('r->IR: print() 印一格 list 还没接（那要 `$名字` 那一层）');
  /* 串在 `print` 里是**带引号**的（`cat` 不带）。转义没做 —— 明写在 SPEC。 */
  const s = t.kind === 'string'
    ? b('+', b('+', { kind: 'string', value: '"' }, exprOf(node, types)), { kind: 'string', value: '"' })
    : asStr(node, types);
  return { kind: 'block', stmts: [wr({ kind: 'string', value: '[1] ' }), wr(s), wr({ kind: 'string', value: '\n' })] };
}

/** `print(…)` 这一格调用 → 语句。 */
function printOf(x, types) {
  const args = posArgs(x);
  if (args.length !== 1) {
    throw new Error(`r->IR: print() 只接一格实参（给了 ${args.length}）—— `
      + '`digits=` / `quote=` 那几个命名实参没接');
  }
  return printValStmt(args[0], types);
}

/**
 * **顶层那一句要不要自动印。**
 *
 * R 在顶层（REPL 与 `Rscript`）对**可见的**值自动调 `print`：`x` 单独一行会印
 * `[1] 3`。赋值、`for` / `while`、`cat()`、`invisible()` 都是不可见的。
 *
 * 用户函数的调用也印 —— 靠 `inferFns()` 推出来的返回类型分：**回 void 的不印**
 * （`f <- function(x) cat(x)` 在 R 里交的是 `cat` 的 `NULL`，也不印）。
 * 这一格从前是"一律不印"，那是因为那时还没有返回类型这张表。
 */
const NO_AUTOPRINT = new Set(['cat', 'print', 'invisible', 'return', 'set.seed', 'stop', 'stopifnot', 'switch']);
function isAutoPrint(k) {
  const t = tag(k);
  if (t === 'bin') return !isAssign(k);
  if (t === 'call') {
    const f = tag(kids(k)[0]) === 'sym' ? nameOf(kids(k)[0]) : null;
    if (f === null || NO_AUTOPRINT.has(f)) return false;
    if (BUILTINS.has(f)) return true;
    const rt = fnRets.get(mangle(f));
    return rt !== undefined && rt.kind !== 'void';
  }
  return ['sym', 'num', 'str', 'un', 'sub1', 'sub2', 'pipe'].includes(t);
}

/** 顶层的一句。与函数体里那一句的差别只有"自动印"这一条。 */
function topStmtOf(k, types) {
  if (tag(k) === 'paren') return topStmtOf(kids(k)[0], types);
  if (isAutoPrint(k)) return printValStmt(k, types);
  return stmtOf(k, types);
}

/**
 * `cat(…)` → 一串 `write`。
 *
 * **为什么不是 `print`**：方言的 `print` 自带换行，而 R 的 `cat` 不带（换行要自己写
 * `"\n"`）。那两件事差一个字节，而例子的判据是**逐字节**对 `Rscript` ——
 * 所以这儿老老实实按 `cat` 的语义发：各实参按 `sep` 连起来，一格不多。
 */
function catOf(x, types) {
  const args = posArgs(x);
  const sepNode = namedArg(x, 'sep');
  let sep = ' ';
  if (sepNode !== undefined) {
    if (tag(sepNode) !== 'str') throw new Error('r->IR: cat() 的 sep= 只接串字面量');
    sep = leaf(kids(sepNode)[0]);
  }
  /* 向量那一格要一个循环，所以这儿发的是**语句**（不是先攒一串串再写）：
     `cat(xs)` 在 R 里把元素按 `sep` 连起来印，而元素个数是运行期才知道的。 */
  const out = [];
  args.forEach((a, i) => {
    if (i > 0 && sep !== '') {
      out.push({ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'string', value: sep }] });
    }
    if (isVecTy(typeOfExpr(a, types))) {
      out.push({
        kind: 'expr-stmt',
        expr: {
          kind: 'call',
          fn: { kind: 'name', name: useFn(isLglTy(typeOfExpr(a, types)) ? 'r_cat_lgl' : 'r_cat_vec') },
          args: [exprOf(a, types), { kind: 'string', value: sep }],
        },
      });
      return;
    }
    /* 字符向量：元素**不带引号**按 `sep` 连起来（`print` 才带引号）。 */
    if (isStrVec(typeOfExpr(a, types))) {
      out.push({
        kind: 'expr-stmt',
        expr: {
          kind: 'call',
          fn: { kind: 'name', name: useFn('r_cat_str') },
          args: [exprOf(a, types), { kind: 'string', value: sep }],
        },
      });
      return;
    }
    out.push({ kind: 'builtin-stmt', name: 'write', args: [asStr(a, types)] });
  });
  return { kind: 'block', stmts: out };
}

/* ─── 语句 ─────────────────────────────────────────────────────────────── */

/** 赋值的左边 → 一条语句（数组/表的下标写落 `aset` / `dset`，标量落 `assign`）。 */
function assignOf(x, types) {
  const { target, value } = assignParts(x);
  const t = tag(target);
  if (t === 'sym') {
    const name = mangle(nameOf(target));
    const want = types.get(name);
    const vt = typeOfExpr(value, types);
    let v = exprOf(value, types, want);
    /* 名字定成了 double、这一句给的是整数 → 提升。R 里 `t <- 0` 之后 `t <- t + 2.5` 是一回事
       （那格量一直是 double），而方言那侧一个名字只有一种类型，所以写的时候对齐。 */
    if (want !== undefined && want.kind === 'real' && vt.kind === 'int') v = asReal(v, vt);
    /* **`x <- TRUE` 之后 `x + 1`**：那格名字被推成 int（`inferRound` 里 bool → int），
       所以赋进去的 bool 也要摊成 1 / 0（见 `asNumE`）。 */
    if (want !== undefined && want.kind !== 'bool' && vt.kind === 'bool') {
      v = want.kind === 'real' ? asReal(v, vt) : asNumE(v, vt);
    }
    const asg = { kind: 'assign', target: { kind: 'name', name }, value: v };
    /* **带名字的向量：名字那一条另发一句**（落在影子变量 `v__nm` 上，见 `RNVEC`）。
       右边推不出名字来（`v <- c(1, 2)` / `v <- unname(w)`）就把名字**清掉** —— R 那边
       也是这样（赋一格没名字的进去，名字就没了），而"跟不住"的那些右边在 `callOf`
       那一格已经当场报过了，到不了这儿。 */
    if (isNamedTy(want ?? globalTys.get(name))) {
      const ns = namesExprOf(value, types)
        ?? call1('anew', tyArg(RSTRV), { kind: 'int', value: 0 });
      return {
        kind: 'block',
        stmts: [asg, { kind: 'assign', target: { kind: 'name', name: nmVar(name) }, value: ns }],
      };
    }
    return asg;
  }
  /* `names(v) <- ns` —— R 的"替换函数"里我们只接这一格：写的是那个影子变量。 */
  if (t === 'call' && tag(kids(target)[0]) === 'sym' && nameOf(kids(target)[0]) === 'names') {
    const a0 = posArgs(target)[0];
    if (a0 === undefined || tag(a0) !== 'sym') {
      throw new Error('r->IR: `names(…) <- …` 的括号里只接一个名字');
    }
    const nm2 = mangle(nameOf(a0));
    if (!isNamedTy(types.get(nm2) ?? globalTys.get(nm2))) {
      throw new Error(`r->IR: \`names(${nameOf(a0)}) <- …\` 的左边要是一条数值向量`
        + '（这一档名字只挂在数值向量上）');
    }
    if (!isStrVec(typeOfExpr(value, types))) {
      throw new Error('r->IR: `names(v) <- …` 右边要是一条字符向量');
    }
    return { kind: 'assign', target: { kind: 'name', name: nmVar(nm2) }, value: exprOf(value, types) };
  }
  /* `m$k <- v` —— 与 `m[["k"]] <- v` 同一件事（值类型也一起推，见 `inferTypes` 的 dicts）。 */
  if (isDollar(target)) {
    const obj = kids(target)[1];
    const ot2 = typeOfExpr(obj, types);
    if (ot2 === undefined || ot2.kind !== 'map') {
      throw new Error('r->IR: `$` 的左边要是一张表（`list(名字 = 值)`）'
        + ` —— 推出来是 ${ot2 === undefined ? '不知道' : ot2.kind}`);
    }
    const vt3 = typeOfExpr(value, types);
    const v3 = ot2.value !== undefined && ot2.value.kind === 'real' && vt3.kind === 'int'
      ? asReal(exprOf(value, types), vt3)
      : exprOf(value, types);
    return {
      kind: 'builtin-stmt',
      name: 'dset',
      args: [exprOf(obj, types), { kind: 'string', value: dollarKey(target) }, v3],
    };
  }
  if (t === 'sub1' || t === 'sub2') {
    const obj = kids(target)[0];
    const keys = kids(target).slice(1).map((a) => kids(a)[0]).filter((k) => k !== undefined);
    if (keys.length !== 1) throw new Error('r->IR: 多维下标的写（x[i, j] <- …）还没接');
    const ot = typeOfExpr(obj, types);
    const o = exprOf(obj, types);
    if (ot.kind === 'map') {
      /* 表的值类型是整张表**一起**推出来的（`inferTypes` 的 dicts 那一段）：
         `list(tol = 0.5)` 之后 `m[["k"]] <- 3` 那个 3 要先加宽成 double，
         不然方言那侧报"dset 的值要是 real，这里是 int"（量出来的）。 */
      const vt2 = typeOfExpr(value, types);
      const v2 = ot.value !== undefined && ot.value.kind === 'real' && vt2.kind === 'int'
        ? asReal(exprOf(value, types), vt2)
        : exprOf(value, types);
      return { kind: 'builtin-stmt', name: 'dset', args: [o, exprOf(keys[0], types), v2] };
    }
    if (isVecTy(ot)) {
      const kv = exprOf(keys[0], types);
      const kt = typeOfExpr(keys[0], types);
      const val = asReal(exprOf(value, types), typeOfExpr(value, types));
      /* **越界就接长**（R 的口径：`x <- c(1,2); x[5] <- 9` 之后 `x` 是 `1 2 NA NA 9`）。
       *
       * 只在左边是**一个名字**的时候接：接长要换一格指针，而换指针就得重新绑到那个变量上，
       * 而"能重新绑"这件事只有名字有（`m$v[i] <- 3` 那种左边不是一格可赋的东西）。
       * 别的形状照旧直接写 —— 越界由运行期的指针边界检查报，不静默。
       *
       * 下标要**先存进一格 int**：它要用两遍（接长那一句与写那一句），而它可能是个
       * 带副作用的表达式（`x[f()] <- 1`）。 */
      if (tag(obj) === 'sym') {
        const vn = mangle(nameOf(obj));
        const tmp = fresh('ix');
        const kk = { kind: 'name', name: tmp };
        const vr = { kind: 'name', name: vn };
        /* 下标在 R 里是 1 起的，`r_ext` 与 `vecAt` 都按这个口径收 —— 所以这儿存的是
           **1 起的 int**（下标是 double 时截一次）。 */
        const out = [
          {
            kind: 'let',
            name: tmp,
            type: INT,
            init: kt !== undefined && kt.kind === 'real' ? call1('toint', kv) : kv,
          },
          {
            kind: 'assign',
            target: vr,
            value: { kind: 'call', fn: { kind: 'name', name: useFn('r_ext') }, args: [vr, kk] },
          },
        ];
        /* 名字那一条跟着长（R：新格的名字是空串）。没名字的向量上这一句发不出来。 */
        if (isNamedTy(ot)) {
          const nr = { kind: 'name', name: nmVar(vn) };
          out.push({
            kind: 'assign',
            target: nr,
            value: { kind: 'call', fn: { kind: 'name', name: useFn('r_ext_nm') }, args: [nr, kk] },
          });
        }
        /* 写。`vecSet` 收的是 0 起的下标，所以这儿把 1 起的减回去。 */
        out.push(vecSet(vr, b('-', kk, { kind: 'int', value: 1 }), val));
        return { kind: 'block', stmts: out };
      }
      return vecSet(o, zeroBased(kv, kt), val);
    }
    /* 字符向量的元素写（`labels[2] <- "x"`）。**越界不会现长** —— R 那边
       `labels[n+1] <- s` 会把向量接长，这儿是 `(aset …)`，越界当场报（明写在 SPEC）。 */
    if (isStrVec(ot)) {
      const vt2 = typeOfExpr(value, types);
      if (vt2.kind !== 'string') {
        throw new Error(`r->IR: 往字符向量里写的不是串（是 ${vt2.kind}）`);
      }
      return {
        kind: 'assign',
        target: svGet(o, zeroBased(exprOf(keys[0], types), typeOfExpr(keys[0], types))),
        value: exprOf(value, types),
      };
    }
    throw new Error(`r->IR: ${nameOf(obj)} 上的下标写不知道是数组还是表 —— 推出来是 ${ot.kind}`);
  }
  throw new Error(`r->IR: 这一格赋值的左边还没接：${t}`);
}

/** `for (v in seq)` → 一格计数循环。`continue` 照跑步进，所以步进要摆在 `post` 上。 */
function forOf(x, types) {
  const fc = kids(x)[0];
  const v = mangle(nameOf(kids(fc)[0]));
  const seq = kids(fc)[1];
  const body = stmtsOf(kids(x)[1], types);
  const name = { kind: 'name', name: v };
  /* **循环量可能被推成 double**：同一个名字在这一段里还当过"在向量上遍历"的那种循环量
     （`for (i in seq_along(xs))` 里元素是 double），而一个名字只有一种类型。
     那时计数这一档的 1 / 上下界都要按 double 摆 —— 不然方言那侧报"两边要同型"。 */
  const vt = types.get(v) ?? INT;
  const one = vt.kind === 'real' ? { kind: 'real', value: 1 } : { kind: 'int', value: 1 };
  const cnt = (e) => (vt.kind === 'real' ? asReal(exprOf(e, types), typeOfExpr(e, types)) : exprOf(e, types));
  const step = { kind: 'assign', target: name, value: b('+', name, one) };

  /* `a:b` 那一档：R 最常见的循环头，直接落成"从 a 数到 b"。 */
  if (tag(seq) === 'bin' && String(leaf(kids(seq)[0])) === ':') {
    const [, lo, hi] = kids(seq);
    return {
      kind: 'for',
      init: { kind: 'assign', target: name, value: cnt(lo) },
      cond: b('<=', name, cnt(hi)),
      post: step,
      body,
    };
  }
  /* `seq_len(n)` 是 `1:n` 的"n 可能是 0"那一版（R 里 `1:0` 会倒着走 —— 那是个真坑）。 */
  if (tag(seq) === 'call' && tag(kids(seq)[0]) === 'sym' && nameOf(kids(seq)[0]) === 'seq_len') {
    const hi = posArgs(seq)[0];
    return {
      kind: 'for',
      init: { kind: 'assign', target: name, value: one },
      cond: b('<=', name, cnt(hi)),
      post: step,
      body,
    };
  }
  /* 向量上的遍历：一格计数循环，体的第一句把元素绑到循环量上。
     序列**先存进临时量** —— 不然 `for (x in c(…))` 每转一圈都会重造那格向量。 */
  if (isStrVec(typeOfExpr(seq, types))) {
    /* 字符向量上的遍历（`for (s in labels)`）—— 与下面那一档同形，只是长度问 `alen`。 */
    const src = fresh('seq');
    const idx = fresh('si');
    const vr = (nm) => ({ kind: 'name', name: nm });
    return {
      kind: 'block',
      stmts: [
        { kind: 'let', name: src, type: RSTRV, init: exprOf(seq, types) },
        {
          kind: 'for',
          init: { kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', vr(idx), svLen(vr(src))),
          post: { kind: 'assign', target: vr(idx), value: b('+', vr(idx), { kind: 'int', value: 1 }) },
          body: [
            { kind: 'assign', target: name, value: svGet(vr(src), vr(idx)) },
            ...body,
          ],
        },
      ],
    };
  }
  if (isVecTy(typeOfExpr(seq, types))) {
    const src = fresh('seq');
    const idx = fresh('si');
    const vr = (nm) => ({ kind: 'name', name: nm });
    return {
      kind: 'block',
      stmts: [
        { kind: 'let', name: src, type: RVEC, init: exprOf(seq, types) },
        {
          kind: 'for',
          init: { kind: 'let', name: idx, type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', vr(idx), vecLen(vr(src))),
          post: { kind: 'assign', target: vr(idx), value: b('+', vr(idx), { kind: 'int', value: 1 }) },
          body: [
            { kind: 'assign', target: name, value: vecGet(vr(src), vr(idx)) },
            ...body,
          ],
        },
      ],
    };
  }
  throw new Error('r->IR: `for (v in …)` 只接 `a:b` / `seq_len(n)` / 一格向量'
    + '（数组上的遍历要先有向量那一层，见 adapter 文件头第 1 条）');}

/** 一格语句。`(block …)` 摊平成一格 block。 */
function stmtOf(x, types) {
  switch (tag(x)) {
    case 'block': return { kind: 'block', stmts: kids(x).map((k) => stmtOf(k, types)) };
    case 'bin': {
      if (isAssign(x)) return assignOf(x, types);
      return { kind: 'expr-stmt', expr: exprOf(x, types) };
    }
    case 'bin-rev': return assignOf(x, types);
    case 'if': {
      const [c, t, e] = kids(x);
      return {
        kind: 'if',
        cond: condOf(c, types),
        then: stmtsOf(t, types),
        else_: e === undefined ? null : stmtsOf(e, types),
      };
    }
    case 'while': return { kind: 'while', cond: condOf(kids(x)[0], types), body: stmtsOf(kids(x)[1], types) };
    /* `repeat { … }` 就是 `while (true) { … }`（R 里它只能靠 `break` 出来）。 */
    case 'repeat': return { kind: 'while', cond: { kind: 'bool', value: true }, body: stmtsOf(kids(x)[0], types) };
    case 'for': return forOf(x, types);
    case 'break': return { kind: 'break', label: null };
    case 'next': return { kind: 'continue', label: null };
    case 'call': {
      const fnNode = kids(x)[0];
      const fn = tag(fnNode) === 'sym' ? nameOf(fnNode) : null;
      /* `cat()` 与 `return()` 在 R 里都是**调用**，落到的却是语句（见文件头第 2 条）。 */
      if (fn === 'cat') return catOf(x, types);
      if (fn === 'print') return printOf(x, types);
      /* `switch(…)` 摆在语句位上时每一支是**语句**（`cat(…)` 只能摆在那儿）。 */
      if (fn === 'switch') return switchOf(x, types, true);
      /* `set.seed(n)` 落成一格 ccall（R 那边它也是"做事不给值"的那一类）。 */
      if (fn === 'set.seed') {
        const vs = posArgs(x);
        if (vs.length !== 1) throw new Error(`r->IR: set.seed() 要一格实参（给了 ${vs.length}）`);
        cabiUsed.add('omni_r_set_seed');
        rmathSig('omni_r_set_seed');
        return {
          kind: 'expr-stmt',
          expr: {
            kind: 'ccall',
            sym: 'omni_r_set_seed',
            args: [asIntE(exprOf(vs[0], types), typeOfExpr(vs[0], types))],
          },
        };
      }
      if (fn === 'return') {
        const vs = posArgs(x);
        return { kind: 'return', values: vs.length === 0 ? [] : [retVal(vs[0], types)] };
      }
      /* `stop(…)` / `stopifnot(…)` —— 停下来那一档，落方言的 `(fail E)`（它是**语句**）。
         与 R 的差别有两处，明写在 SPEC：R 印 `Error: …` 并退出 1，我们印
         `omni: runtime error: …` 并退出 70（方言里 `(fail …)` 的口径）；
         `stopifnot` 的那句话 R 里是把**表达式本身**反解出来（`x > 0 is not TRUE`），
         这一层没有 deparse，所以给的是一句固定的。 */
      if (fn === 'stop' || fn === 'stopifnot') {
        const vs = posArgs(x);
        if (vs.length === 0) throw new Error(`r->IR: ${fn}() 要至少一格实参`);
        if (fn === 'stop') {
          const msg = vs.map((a) => asStr(a, types, 15)).reduce((acc, p) => b('+', acc, p));
          return { kind: 'builtin-stmt', name: 'fail', args: [msg] };
        }
        return {
          kind: 'block',
          stmts: vs.map((a) => ({
            kind: 'if',
            cond: { kind: 'unop', op: '!', operand: condOf(a, types) },
            then: [{ kind: 'builtin-stmt', name: 'fail', args: [{ kind: 'string', value: 'stopifnot: 有一格条件不成立' }] }],
            else_: null,
          })),
        };
      }
      return { kind: 'expr-stmt', expr: exprOf(x, types) };
    }
    case 'paren': return stmtOf(kids(x)[0], types);
    default:
      return { kind: 'expr-stmt', expr: exprOf(x, types) };
  }
}

/** 一格"体"（可能是 `{…}`，也可能是单独一句）→ 一串语句。 */
function stmtsOf(x, types) {
  if (tag(x) === 'block') return kids(x).map((k) => stmtOf(k, types));
  return [stmtOf(x, types)];
}

/* ─── 尾位（R 的"最后一句就是返回值"） ────────────────────────────────── */

/**
 * 函数体 → 一串语句，**最后一句变成 `return`**。
 *
 * 往 `if` 的两支里钻，不囫囵包成 `ternary`：`if (n == 0) return(1)` 那种只有一支带值
 * （另一支往下走到后面的语句），包成三元就要求两支都有值 —— 那是一条假的要求。
 * `for` / `while` / 赋值 结尾的函数在 R 里回的是不可见的 `NULL`，那时不补 `return`。
 */
function tailBody(node, types) {
  const list = tag(node) === 'block' ? kids(node) : [node];
  if (list.length === 0) return [];
  const head = list.slice(0, -1).map((k) => stmtOf(k, types));
  return [...head, ...tailOf(list[list.length - 1], types)];
}

/**
 * **这个函数交什么类型**（`fnDecl` 在发它的体之前摆好）。
 *
 * 为什么要这一格：`fibm <- function(n) { if (n <= 2) return(1); … memo[n] }` 交的是
 * double（`memo` 是向量），而 `return(1)` 那一句给的是 int —— 方言那层不隐式加宽，
 * 于是"要返回 real，给的是 int"。R 里这两支本来就是同一种东西（都是 double），
 * 所以这儿按函数的回值类型把每一处 `return` 对齐。
 */
let curRet = null;

/** 一格 `return` 的值 → 按 `curRet` 对齐（只加宽，不缩窄）。 */
function retVal(node, types) {
  const e = exprOf(node, types);
  if (curRet === null || curRet.kind !== 'real') return e;
  return asReal(e, typeOfExpr(node, types));
}

/** 尾位上的一格东西 → 一串语句（带 `return` 的那种）。 */
function tailOf(x, types) {
  switch (tag(x)) {
    case 'block': return tailBody(x, types);
    case 'paren': return tailOf(kids(x)[0], types);
    case 'if': {
      const [c, t, e] = kids(x);
      return [{
        kind: 'if',
        cond: condOf(c, types),
        then: tailOf(t, types),
        else_: e === undefined ? null : tailOf(e, types),
      }];
    }
    /* 这几格在 R 里的值是不可见的 NULL —— 不补 `return`，照常当语句。 */
    case 'for': case 'while': case 'repeat': case 'break': case 'next':
      return [stmtOf(x, types)];
    case 'bin': case 'bin-rev':
      if (isAssign(x)) return [stmtOf(x, types)];
      return [{ kind: 'return', values: [retVal(x, types)] }];
    case 'call': {
      const fnNode = kids(x)[0];
      const fn = tag(fnNode) === 'sym' ? nameOf(fnNode) : null;
      if (fn === 'cat' || fn === 'return') return [stmtOf(x, types)];
      /* 尾位上的 `switch`：每一支都在"做事"时按语句落（见 `switchIsStmt`）。 */
      if (fn === 'switch' && switchIsStmt(x)) return [stmtOf(x, types)];
      return [{ kind: 'return', values: [retVal(x, types)] }];
    }
    default:
      return [{ kind: 'return', values: [retVal(x, types)] }];
  }
}

/* ─── 顶层 ─────────────────────────────────────────────────────────────── */

/**
 * 补出来那格 `let` 的初值。
 *
 * 数与串有零值（公共降级器的 `lower/ty.js` 那张表给），**数组与表没有** ——
 * 那一格必须由这门语言答（`(arr int) 这一格还没有零值` 就是它在报）。
 * R 里"没赋值过的向量"本来也没有意义，所以给一格空的最诚实：后面那句赋值会盖掉它。
 */
function zeroInit(t) {
  /* 向量的零值是**空向量**：开一格槽（就是那个长度），紧跟的 `zeroStmts` 往里写 0。
     `(ptr real)` 在公共层没有零值（`lower/ty.js` 会当场报）—— 这一格必须由这门语言答。 */
  if (isVecTy(t)) return call1('pnew', tyArg(RVEC), { kind: 'int', value: 1 });
  /* 字符向量的零值是**零长的那条**（`(arr string)` 在公共层也没有零值）。 */
  if (isStrVec(t)) return call1('anew', tyArg(RSTRV), { kind: 'int', value: 0 });
  if (t.kind === 'map') return call1('dnew', tyArg(t));
  return null;
}

/** 补出来那格 `let` 之后紧跟的初始化语句（向量要现开一格空的 —— `let` 的初值给不出来）。 */
function zeroStmts(name, t) {
  if (!isVecTy(t)) return [];
  const v = { kind: 'name', name };
  return [{ kind: 'assign', target: { kind: 'deref', expr: v }, value: { kind: 'real', value: 0 } }];
}

/**
 * 那格"数怎么印"的辅助函数，**用到了才发**。
 *
 * R 印 double 有三处特例：`NA` 印 `NA`、`NaN` 印 `NaN`、无穷印 `Inf` / `-Inf`，
 * 剩下的才是有效数字那一套。这三格判在 C 那侧（`is.na` 对 NaN 也真，所以要先问
 * `is.nan` 才分得开 NA 与 NaN），而"印法"这件事是**每个 cat 都要做一遍**的 ——
 * 所以落成一个函数发一次，而不是在每个调用点摊开一串三元（那样 `.sx` 读不动）。
 *
 * 剩下那一段是 `numFmtStmts()`：**照 `src/main/format.c` 抄的**，不是 `%.7g`。
 */
function numStrDecl() {
  cabiUsed.add('omni_r_is_infinite');
  rmathSig('omni_r_is_infinite');
  const x = { kind: 'name', name: 'x' };
  /* NA / NaN 那两问走按指针的生成函数；无穷那一问没有载荷，按值就行。 */
  const q = (name) => ({ kind: 'call', fn: { kind: 'name', name: useFn(name) }, args: [x] });
  const c = (sym) => b('!=', { kind: 'ccall', sym, args: [x] }, { kind: 'int', value: 0 });
  const ret = (v) => ({ kind: 'return', values: [{ kind: 'string', value: v }] });
  return {
    kind: 'fn',
    name: NUM_STR,
    params: [{ name: 'x', type: REAL }, { name: 'd', type: INT }],
    ret: STR,
    body: [
      /* `is.na` 对 NA 与 NaN 都真 —— 先问 `is.nan` 才分得开这两格 */
      {
        kind: 'if',
        cond: q('r_is_na'),
        then: [{ kind: 'if', cond: q('r_is_nan'), then: [ret('NaN')], else_: null }, ret('NA')],
        else_: null,
      },
      {
        kind: 'if',
        cond: c('omni_r_is_infinite'),
        then: [
          {
            kind: 'if',
            cond: b('>', x, { kind: 'real', value: 0 }),
            then: [ret('Inf')],
            else_: null,
          },
          ret('-Inf'),
        ],
        else_: null,
      },
      /* **负零归一**（与 `r_num_fmt` 里那一格同一条：R 的 `EncodeReal0` 有
         `if(x == 0.) x = 0.;`，所以 `cat(-0.0)` 印的是 `0`）。 */
      {
        kind: 'if',
        cond: b('==', x, { kind: 'real', value: 0 }),
        then: [{ kind: 'assign', target: x, value: { kind: 'real', value: 0 } }],
        else_: null,
      },
      ...numFmtStmts(),
    ],
  };
}

/**
 * 串那几格生成出来的辅助函数。
 *
 * 为什么不摊在调用点：`substr` 要**先量长度再截**（R 越界是截断，方言的 `(ssub …)`
 * 越界当场报），`startsWith` / `endsWith` 与那两格补空格的也都要把实参读两遍 ——
 * 一次函数调用是纯表达式，摊开的临时量在条件位上没地方摆（见 `FN_DEPS` 那段账）。
 */
function strFnDecl(name) {
  const nm = (n2) => ({ kind: 'name', name: n2 });
  const I = (v) => ({ kind: 'int', value: v });
  const S = (v) => ({ kind: 'string', value: v });
  const letI = (n2, init) => ({ kind: 'let', name: n2, type: INT, init });
  const set = (n2, v) => ({ kind: 'assign', target: nm(n2), value: v });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const ret = (e) => ({ kind: 'return', values: [e] });
  const s = nm('s');
  const t = nm('t');
  const P2 = [{ name: 's', type: STR }, { name: 't', type: STR }];

  if (name === 'r_substr') {
    /* R：1 起、两端都含、越界**截断**（`substr("abc", 2, 99)` 是 `"bc"`）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 's', type: STR }, { name: 'a', type: INT }, { name: 'z', type: INT }],
      ret: STR,
      body: [
        letI('n', call1('slen', s)),
        letI('i', nm('a')),
        letI('j', nm('z')),
        iff(b('<', nm('i'), I(1)), [set('i', I(1))]),
        iff(b('>', nm('j'), nm('n')), [set('j', nm('n'))]),
        iff(b('<', nm('j'), nm('i')), [ret(S(''))]),
        ret(call1('ssub', s, b('-', nm('i'), I(1)), b('+', b('-', nm('j'), nm('i')), I(1)))),
      ],
    };
  }
  if (name === 'r_starts') {    /* `(sfind S T)` 回的是第一次出现的下标（没有是 -1），所以"开头"就是下标 0。 */
    return {
      kind: 'fn', name, params: P2, ret: BOOL, body: [ret(b('==', call1('sfind', s, t), I(0)))],
    };
  }
  if (name === 'r_ends') {
    return {
      kind: 'fn',
      name,
      params: P2,
      ret: BOOL,
      body: [
        letI('n', call1('slen', s)),
        letI('m', call1('slen', t)),
        iff(b('>', nm('m'), nm('n')), [ret({ kind: 'bool', value: false })]),
        ret(b('==', call1('ssub', s, b('-', nm('n'), nm('m')), nm('m')), t)),
      ],
    };
  }
  if (name === 'r_lower') {
    /* `tolower` —— 方言里**只有 `(supper …)`**，没有反过来的那一格。补它要给核心方言加
       一格算子（五条腿都要动），所以这儿用现成的算子办：拿两张 26 个字母的表查一遍
       （`(sfind 大写表 这个字符)` 给位置，再从小写表里取同一格）。
       **只管 ASCII** —— R 的 `tolower` 对非 ASCII 是跟 locale 走的，那一层没有
       （表里查不到的字符原样留下，明写在 SPEC）。 */
    const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const LO = 'abcdefghijklmnopqrstuvwxyz';
    const ch = call1('ssub', s, nm('i'), I(1));
    return {
      kind: 'fn',
      name,
      params: [{ name: 's', type: STR }],
      ret: STR,
      body: [
        letI('n', call1('slen', s)),
        { kind: 'let', name: 'o', type: STR, init: S('') },
        {
          kind: 'for',
          init: letI('i', I(0)),
          cond: b('<', nm('i'), nm('n')),
          post: set('i', b('+', nm('i'), I(1))),
          body: [
            { kind: 'let', name: 'c', type: STR, init: ch },
            letI('k', call1('sfind', S(UP), nm('c'))),
            iff(b('>=', nm('k'), I(0)),
              [set('o', b('+', nm('o'), call1('ssub', S(LO), nm('k'), I(1))))],
              [set('o', b('+', nm('o'), nm('c')))]),
          ],
        },
        ret(nm('o')),
      ],
    };
  }
  if (name === 'r_trim') {
    /**
     * `trimws(s, which)` —— 去掉空白（R 的空白是 `[ \t\r\n]`）。`w` 是哪一头：
     * `0` 两头（R 的默认 `"both"`）、`1` 只左边、`2` 只右边。
     *
     * 摆成一格参数而不是三个函数：两头那两趟本来就是各自独立的 `while`，多一格 `if`
     * 比多两份函数体短，也不会让"哪一头"这件事有两处说法。
     */
    const ws = (e) => b('||', b('||', b('==', e, S(' ')), b('==', e, S('\t'))),
      b('||', b('==', e, S('\r')), b('==', e, S('\n'))));
    const w = nm('w');
    return {
      kind: 'fn',
      name,
      params: [{ name: 's', type: STR }, { name: 'w', type: INT }],
      ret: STR,
      body: [
        letI('n', call1('slen', s)),
        letI('a', I(0)),
        letI('z', nm('n')),
        iff(b('!=', w, I(2)), [{
          kind: 'while',
          cond: b('&&', b('<', nm('a'), nm('z')), ws(call1('ssub', s, nm('a'), I(1)))),
          body: [set('a', b('+', nm('a'), I(1)))],
        }]),
        iff(b('!=', w, I(1)), [{
          kind: 'while',
          cond: b('&&', b('>', nm('z'), nm('a')), ws(call1('ssub', s, b('-', nm('z'), I(1)), I(1)))),
          body: [set('z', b('-', nm('z'), I(1)))],
        }]),
        ret(call1('ssub', s, nm('a'), b('-', nm('z'), nm('a')))),
      ],
    };
  }
  if (name === 'r_chartr') {
    /**
     * `chartr(old, new, x)`：`old` 里的第 k 个字符换成 `new` 里的第 k 个，表外的原样留下
     * （量出来 `chartr("abc", "xyz", "cab")` 是 `"zxy"`）。办法与 `r_lower` 同一条 ——
     * `(sfind old c)` 给位置，再从 `new` 里取同一格。
     *
     * `old` 比 `new` 长时 R 报错（"'old' is longer than 'new'"），这儿也当场停下来。
     * **按字节办**：非 ASCII 的串字面量在调用点上就被 `BYTEWISE` 那张表拦了（多字节
     * 字符按字节查会切出半个字符），运行期才知道的拦不住 —— 明写在 SPEC。
     */
    const o = nm('o');
    const on = nm('on');
    const nw = nm('nw');
    const c = nm('c');
    return {
      kind: 'fn',
      name,
      params: [{ name: 'on', type: STR }, { name: 'nw', type: STR }, { name: 's', type: STR }],
      ret: STR,
      body: [
        iff(b('>', call1('slen', on), call1('slen', nw)), [{
          kind: 'builtin-stmt',
          name: 'fail',
          args: [{ kind: 'string', value: "chartr(): 'old' 比 'new' 长 —— 后头那几格换成什么说不清（R 也报这一句）" }],
        }]),
        letI('n', call1('slen', s)),
        { kind: 'let', name: 'o', type: STR, init: S('') },
        {
          kind: 'for',
          init: letI('i', I(0)),
          cond: b('<', nm('i'), nm('n')),
          post: set('i', b('+', nm('i'), I(1))),
          body: [
            { kind: 'let', name: 'c', type: STR, init: call1('ssub', s, nm('i'), I(1)) },
            letI('k', call1('sfind', on, c)),
            iff(b('>=', nm('k'), I(0)),
              [set('o', b('+', o, call1('ssub', nw, nm('k'), I(1))))],
              [set('o', b('+', o, c))]),
          ],
        },
        ret(o),
      ],
    };
  }
  if (name === 'r_pad0') {
    /* `%05.1f` 那一格：补**零**而不是空格，而且**符号留在最前**（-1.5 是 `-01.5`）。 */
    const fill0 = call1('srep', S('0'), b('-', nm('w'), call1('slen', s)));
    return {
      kind: 'fn',
      name,
      params: [{ name: 's', type: STR }, { name: 'w', type: INT }],
      ret: STR,
      body: [
        iff(b('>=', call1('slen', s), nm('w')), [ret(s)]),
        iff(b('==', call1('ssub', s, I(0), I(1)), S('-')),
          [ret(b('+', b('+', S('-'), call1('srep', S('0'), b('-', nm('w'), call1('slen', s)))),
            call1('ssub', s, I(1), b('-', call1('slen', s), I(1)))))]),
        ret(b('+', fill0, s)),
      ],
    };
  }
  if (name === 'r_format1') {
    /**
     * 一格**数**按 `format()` 排版。底子就是 `cat` / `print` 那一条（7 位有效数字、
     * 定点与科学记数照 `format.c` 挑）—— 所以 `format(1/3)` 是 `0.3333333`、
     * `format(1e5)` 是 `1e+05`。
     *
     * `nsmall = k` 是"**至少** k 位小数"，而且**只在定点那一侧管**：量出来
     * `format(1e5, nsmall = 2)` 还是 `1e+05`（不是 `100000.00`）、
     * `format(1/3, nsmall = 2)` 还是 `0.3333333`（已经够了）、
     * `format(1.5, nsmall = 3)` 才变成 `1.500`。所以这儿先看挑出来那串里有没有 `e`，
     * 有就一个字都不动；没有才数小数位、不够时按 `nsmall` 重排一遍（`sfix`）。
     * `NA` / `NaN` / `±Inf` 也一个字都不动（那三格没有小数位这一说）。
     *
     * `width = k` 是"至少 k 宽"，数**右对齐**（串是左对齐，那一格在调用点上用 `r_padr`）。
     */
    cabiUsed.add('omni_r_is_infinite');
    rmathSig('omni_r_is_infinite');
    const xx = nm('x');
    const out = nm('o');
    const fin = b('&&', { kind: 'unop', op: '!', operand: naQ(xx) },
      b('==', { kind: 'ccall', sym: 'omni_r_is_infinite', args: [xx] }, I(0)));
    const dec = nm('dec');
    return {
      kind: 'fn',
      name,
      params: [{ name: 'x', type: REAL }, { name: 'ns', type: INT }, { name: 'w', type: INT }],
      ret: STR,
      body: [
        { kind: 'let', name: 'o', type: STR, init: { kind: 'call', fn: { kind: 'name', name: useFn(NUM_STR) }, args: [xx, I(7)] } },
        iff(b('&&', b('>', nm('ns'), I(0)),
          b('&&', fin, b('<', call1('sfind', out, S('e')), I(0)))), [
          letI('k', call1('sfind', out, S('.'))),
          letI('dec', I(0)),
          iff(b('>=', nm('k'), I(0)),
            [set('dec', b('-', b('-', call1('slen', out), nm('k')), I(1)))]),
          iff(b('<', dec, nm('ns')), [set('o', call1('sfix', xx, nm('ns')))]),
        ]),
        ret(b('+', call1('srep', S(' '), b('-', nm('w'), call1('slen', out))), out)),
      ],
    };
  }
  /* `sprintf` 的宽度那一格：右对齐（`%5d`）与左对齐（`%-5s`）。
     `(srep S N)` 在 N <= 0 时回空串（方言明说的），所以不用另外夹一下。 */
  const fill = call1('srep', S(' '), b('-', nm('w'), call1('slen', s)));
  return {
    kind: 'fn',
    name,
    params: [{ name: 's', type: STR }, { name: 'w', type: INT }],
    ret: STR,
    body: [ret(name === 'r_padl' ? b('+', fill, s) : b('+', s, fill))],
  };
}

/** 这一批由 `strvFnDecl` 发（形状都是"一条 `(arr string)` 进"）。 */
const STRV_FNS = new Set([
  'r_cat_str', 'r_print_str', 'r_join_str', 'r_rev_str', 'r_nchar_v', 'r_upper_v', 'r_lower_v',
  'r_pick_str', 'r_mask_str', 'r_split', 'r_at_name', 'r_nm_at',
  'r_gsub', 'r_gsub_v', 'r_grepl_v', 'r_grep_i', 'r_grep_s', 'r_rep_str', 'r_ifelse_s',
  'r_substr_v', 'r_trim_v', 'r_starts_v', 'r_ends_v',
  /* base 那四条字符向量常量 + `strrep` 在字符向量上那一格。 */
  'r_sv_letters', 'r_sv_upper', 'r_sv_month', 'r_sv_mabb', 'r_strrep_v', 'r_chartr_v',
  'r_as_str_v', 'r_as_str_lv',
  'r_sv1', 'r_sort_str', 'r_order_str', 'r_any_dup_str', 'r_uniq_str', 'r_dup_str', 'r_match_str', 'r_in_str', 'r_in1_str',
  'r_union_str', 'r_isect_str', 'r_sdiff_str', 'r_head_str', 'r_tail_str',
]);

/** 这一批由 `setFnDecl` 发（集合与位置那一族，见 `FN_DEPS` 上那段账）。 */
const SET_FNS = new Set([
  'r_same', 'r_which_max', 'r_which_min', 'r_cumprod', 'r_pmax', 'r_pmin',
  'r_ord_lt', 'r_order', 'r_match', 'r_in_v', 'r_in1', 'r_unique', 'r_dup', 'r_any_dup',
  'r_union', 'r_intersect', 'r_setdiff', 'r_setequal', 'r_find_int',
]);

/**
 * 集合与位置那一族生成出来的辅助函数：`match` / `%in%` / `unique` / `duplicated` /
 * `union` / `intersect` / `setdiff` / `order` / `which.max` / `which.min` /
 * `cumprod` / `pmax` / `pmin`。
 *
 * 两处 R 的规矩，都在 `r_same` 与 `r_ord_lt` 里：
 *
 *   * **`NA` 与 `NA` 算同一格**（`NA %in% NA` 是 TRUE、`unique(c(NA, NA))` 只剩一格），
 *     `NaN` 与 `NaN` 也算同一格，而 `NA` 与 `NaN` **不是**同一格。按 `==` 比这三问全是假
 *     （浮点的规矩），所以单独一个函数答。
 *   * `order` 把缺失摆**最后**，而且是**稳定**的（同值按原来的次序）。这儿的比较把
 *     "原下标"当最后一把钥匙 —— 于是那个次序是**唯一**的，用哪种排序算法都得到 R 那一条
 *     （不必真写一个稳定排序）。
 */
function setFnDecl(name) {
  const nm = (s) => ({ kind: 'name', name: s });
  const I = (v) => ({ kind: 'int', value: v });
  const R = (v) => ({ kind: 'real', value: v });
  const letI = (s, init) => ({ kind: 'let', name: s, type: INT, init });
  const letB = (s, init) => ({ kind: 'let', name: s, type: BOOL, init });
  const set = (s, v) => ({ kind: 'assign', target: nm(s), value: v });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const ret = (e) => ({ kind: 'return', values: [e] });
  const cal = (f, ...a) => ({ kind: 'call', fn: { kind: 'name', name: useFn(f) }, args: a });
  const i = nm('i');
  const j = nm('j');
  const v = nm('v');
  const w = nm('w');
  const o = nm('o');
  const k = nm('k');
  /* `for (idx = 0; idx < upto; idx++)` */
  const forTo = (idx, upto, body) => ({
    kind: 'for',
    init: letI(idx, I(0)),
    cond: b('<', nm(idx), upto),
    post: set(idx, b('+', nm(idx), I(1))),
    body,
  });
  /* 结果向量的长度改写成 k（先按上界开、填完再说实际有几格 —— 槽 0 就是长度）。 */
  const setLen = (e) => ({ kind: 'assign', target: { kind: 'deref', expr: o }, value: call1('toreal', e) });
  const naOf = () => cal('r_na');
  const isNa = (e) => cal('r_is_na', e);
  const same = (a, c) => cal('r_same', a, c);
  const P1 = [{ name: 'v', type: RVEC }];
  const P2 = [{ name: 'v', type: RVEC }, { name: 'w', type: RVEC }];

  if (name === 'r_same') {
    /* "算不算同一格"：`NaN` 只与 `NaN` 同、`NA` 只与 `NA` 同、别的按 `==`。 */
    const a = nm('a');
    const c = nm('c');
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: REAL }, { name: 'c', type: REAL }],
      ret: BOOL,
      body: [
        letB('qa', cal('r_is_nan', a)),
        letB('qc', cal('r_is_nan', c)),
        iff(b('||', nm('qa'), nm('qc')), [ret(b('&&', nm('qa'), nm('qc')))]),
        letB('ma', isNa(a)),
        letB('mc', isNa(c)),
        iff(b('||', nm('ma'), nm('mc')), [ret(b('&&', nm('ma'), nm('mc')))]),
        ret(b('==', a, c)),
      ],
    };
  }
  if (name === 'r_which_max' || name === 'r_which_min') {
    /* R 的 `which.max` **跳过缺失**，回第一个取到极值的那一格（1 起）。
       一格非缺失都没有时 R 回 `integer(0)`（印出来什么都没有）—— 这一档没有"零长整数"
       这种值，所以当场停下来（明写在 SPEC）。 */
    const op = name === 'r_which_max' ? '>' : '<';
    return {
      kind: 'fn',
      name,
      params: P1,
      ret: INT,
      body: [
        letI('n', vecLen(v)),
        letI('bi', I(-1)),
        forTo('i', nm('n'), [
          iff({ kind: 'unop', op: '!', operand: isNa(vecGet(v, i)) }, [
            iff(b('||', b('<', nm('bi'), I(0)), b(op, vecGet(v, i), vecGet(v, nm('bi')))),
              [set('bi', i)]),
          ]),
        ]),
        iff(b('<', nm('bi'), I(0)), [{
          kind: 'builtin-stmt',
          name: 'fail',
          args: [{ kind: 'string', value: 'which.max/which.min: 一格非缺失的都没有（R 回 integer(0)，这一档没有那种值）' }],
        }]),
        ret(b('+', nm('bi'), I(1))),
      ],
    };
  }
  if (name === 'r_cumprod') {
    return {
      kind: 'fn',
      name,
      params: P1,
      ret: RVEC,
      body: [
        letI('n', vecLen(v)),
        ...vecNewAs('o', nm('n')),
        { kind: 'let', name: 'p', type: REAL, init: R(1) },
        forTo('i', nm('n'), [
          set('p', b('*', nm('p'), vecGet(v, i))),
          vecSet(o, i, nm('p')),
        ]),
        ret(o),
      ],
    };
  }
  if (name === 'r_pmax' || name === 'r_pmin') {
    /* 逐元素取大/取小，两边按 R 的回收规则对齐；有一边是缺失就交缺失（`na.rm` 默认是
       FALSE）。有一边零长时 R 出零长（这儿也一样 —— 不然 `i % 0` 要炸）。 */
    const op = name === 'r_pmax' ? '>' : '<';
    const x = vecGet(v, b('%', i, nm('nv')));
    const y = vecGet(w, b('%', i, nm('nw')));
    return {
      kind: 'fn',
      name,
      params: P2,
      ret: RVEC,
      body: [
        letI('nv', vecLen(v)),
        letI('nw', vecLen(w)),
        letI('m', nm('nv')),
        iff(b('<', nm('m'), nm('nw')), [set('m', nm('nw'))]),
        iff(b('||', b('==', nm('nv'), I(0)), b('==', nm('nw'), I(0))), [set('m', I(0))]),
        ...vecNewAs('o', nm('m')),
        forTo('i', nm('m'), [
          iff(b('||', isNa(x), isNa(y)),
            [vecSet(o, i, naOf())],
            [vecSet(o, i, { kind: 'ternary', cond: b(op, x, y), then: x, else_: y })]),
        ]),
        ret(o),
      ],
    };
  }
  return setFnDecl2(name);
}

/** `setFnDecl` 的后一半（同一族，分两段只为每段读得完）。 */
function setFnDecl2(name) {
  const nm = (s) => ({ kind: 'name', name: s });
  const I = (v) => ({ kind: 'int', value: v });
  const R = (v) => ({ kind: 'real', value: v });
  const letI = (s, init) => ({ kind: 'let', name: s, type: INT, init });
  const letB = (s, init) => ({ kind: 'let', name: s, type: BOOL, init });
  const set = (s, v) => ({ kind: 'assign', target: nm(s), value: v });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const ret = (e) => ({ kind: 'return', values: [e] });
  const cal = (f, ...a) => ({ kind: 'call', fn: { kind: 'name', name: useFn(f) }, args: a });
  const i = nm('i');
  const j = nm('j');
  const v = nm('v');
  const w = nm('w');
  const o = nm('o');
  const forTo = (idx, upto, body) => ({
    kind: 'for',
    init: letI(idx, I(0)),
    cond: b('<', nm(idx), upto),
    post: set(idx, b('+', nm(idx), I(1))),
    body,
  });
  const setLen = (e) => ({ kind: 'assign', target: { kind: 'deref', expr: o }, value: call1('toreal', e) });
  const isNa = (e) => cal('r_is_na', e);
  const same = (a, c) => cal('r_same', a, c);
  const P1 = [{ name: 'v', type: RVEC }];
  const P2 = [{ name: 'v', type: RVEC }, { name: 'w', type: RVEC }];

  if (name === 'r_ord_lt') {
    /* `order` 的比较：缺失摆最后，同值按**原下标**分先后（于是这个次序是唯一的）。
       `a` / `c` 是两格下标（按 double 存在那条索引向量里）。 */
    const ai = call1('toint', nm('a'));
    const ci = call1('toint', nm('c'));
    const xa = vecGet(v, ai);
    const xc = vecGet(v, ci);
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'a', type: REAL }, { name: 'c', type: REAL }],
      ret: BOOL,
      body: [
        letB('ma', isNa(xa)),
        letB('mc', isNa(xc)),
        iff(b('&&', nm('ma'), nm('mc')), [ret(b('<', nm('a'), nm('c')))]),
        iff(nm('ma'), [ret({ kind: 'bool', value: false })]),
        iff(nm('mc'), [ret({ kind: 'bool', value: true })]),
        iff(b('<', xa, xc), [ret({ kind: 'bool', value: true })]),
        iff(b('>', xa, xc), [ret({ kind: 'bool', value: false })]),
        ret(b('<', nm('a'), nm('c'))),
      ],
    };
  }
  if (name === 'r_order') {
    /* 排的是**下标**（Shell 排序，与 `r_sort` 同一条 gap 序列），比较交给 `r_ord_lt`。 */
    return {
      kind: 'fn',
      name,
      params: P1,
      ret: RVEC,
      body: [
        letI('n', vecLen(v)),
        ...vecNewAs('o', nm('n')),
        forTo('i', nm('n'), [vecSet(o, i, call1('toreal', i))]),
        letI('h', I(1)),
        { kind: 'while', cond: b('<', nm('h'), b('/', nm('n'), I(3))), body: [set('h', b('+', b('*', I(3), nm('h')), I(1)))] },
        {
          kind: 'while',
          cond: b('>=', nm('h'), I(1)),
          body: [
            {
              kind: 'for',
              init: letI('i', nm('h')),
              cond: b('<', i, nm('n')),
              post: set('i', b('+', i, I(1))),
              body: [
                { kind: 'let', name: 't', type: REAL, init: vecGet(o, i) },
                letI('j', i),
                {
                  kind: 'while',
                  cond: b('&&', b('>=', j, nm('h')),
                    cal('r_ord_lt', v, nm('t'), vecGet(o, b('-', j, nm('h'))))),
                  body: [
                    vecSet(o, j, vecGet(o, b('-', j, nm('h')))),
                    set('j', b('-', j, nm('h'))),
                  ],
                },
                vecSet(o, j, nm('t')),
              ],
            },
            set('h', b('/', b('-', nm('h'), I(1)), I(3))),
          ],
        },
        /* 内部是 0 起的，交出去要 1 起（R 的 `order` 回的是位置）。 */
        forTo('i', nm('n'), [vecSet(o, i, b('+', vecGet(o, i), R(1)))]),
        ret(o),
      ],
    };
  }
  if (name === 'r_match' || name === 'r_in_v') {
    /* `match(x, t)` 回位置（找不到是 `NA`）、`x %in% t` 回真假。两格都是"对 x 的每一格
       在 t 里找第一处相同的"，所以合在一处写。 */
    const mat = name === 'r_match';
    return {
      kind: 'fn',
      name,
      params: P2,
      ret: mat ? RVEC : RLGL,
      body: [
        letI('n', vecLen(v)),
        letI('m', vecLen(w)),
        ...vecNewAs('o', nm('n')),
        forTo('i', nm('n'), [
          vecSet(o, i, mat ? cal('r_na') : R(0)),
          forTo('j', nm('m'), [
            iff(same(vecGet(v, i), vecGet(w, j)), [
              vecSet(o, i, mat ? call1('toreal', b('+', j, I(1))) : R(1)),
              { kind: 'break' },
            ]),
          ]),
        ]),
        ret(o),
      ],
    };
  }
  if (name === 'r_setequal') {
    /**
     * `setequal(a, b)`：**当集合看**一不一样 —— 重复的那几格不算（R：
     * `setequal(c(1,1,2), c(2,1))` 是 TRUE），`NA` 与 `NA` 算同一格（`r_same` 的口径，
     * 量出来 `setequal(c(NA,1), c(1,NA))` 是 TRUE）。
     *
     * 办法就是两边各问一遍"另一条里有没有这一格" —— `r_in1` 回的是 `1.0` / `0.0`
     * （三态标量那种存法），所以这儿与 `1` 比一下收成 bool。
     */
    const inW = (e, tbl) => b('==', cal('r_in1', e, tbl), R(1));
    return {
      kind: 'fn',
      name,
      params: P2,
      ret: BOOL,
      body: [
        letI('n', vecLen(v)),
        letI('m', vecLen(w)),
        forTo('i', nm('n'), [iff({ kind: 'unop', op: '!', operand: inW(vecGet(v, i), w) },
          [ret({ kind: 'bool', value: false })])]),
        forTo('j', nm('m'), [iff({ kind: 'unop', op: '!', operand: inW(vecGet(w, j), v) },
          [ret({ kind: 'bool', value: false })])]),
        ret({ kind: 'bool', value: true }),
      ],
    };
  }
  if (name === 'r_find_int') {
    /**
     * `findInterval(x, vec)`：每一格 `x[i]` 落在哪一段 —— 回的是**有几格断点 `<= x[i]`**
     * （所以 `x` 比所有断点都小就是 0，比所有都大就是 `length(vec)`）。缺失回 `NA`
     * （量出来 `findInterval(c(NA,2), c(1,2))` 是 `NA 2`）。
     *
     * R 那边是二分查找，这儿是数一遍 —— **断点升着排**时两者同解（R 的文档也只在
     * "vec 已排序"时给结果，没排序它自己说结果 undefined）。
     */
    return {
      kind: 'fn',
      name,
      params: P2,
      ret: RIVEC,
      body: [
        letI('n', vecLen(v)),
        letI('m', vecLen(w)),
        ...vecNewAs('o', nm('n')),
        forTo('i', nm('n'), [
          iff(isNa(vecGet(v, i)), [vecSet(o, i, cal('r_na'))], [
            letI('c', I(0)),
            forTo('j', nm('m'), [
              iff(b('<=', vecGet(w, j), vecGet(v, i)), [set('c', b('+', nm('c'), I(1)))]),
            ]),
            vecSet(o, i, call1('toreal', nm('c'))),
          ]),
        ]),
        ret(o),
      ],
    };
  }
  if (name === 'r_any_dup') {
    /**
     * `anyDuplicated(v)` —— 回**第一格重复元素的位置**（1 起），没有回 `0`
     * （量出来 `anyDuplicated(c(1,2,1))` 是 3、`anyDuplicated(c(1,2))` 是 0）。
     * "算不算同一格"照旧走 `r_same`（`NA` 与 `NA` 算同一格）。
     */
    return {
      kind: 'fn',
      name,
      params: P1,
      ret: INT,
      body: [
        letI('n', vecLen(v)),
        forTo('i', nm('n'), [{
          kind: 'for',
          init: letI('j', I(0)),
          cond: b('<', nm('j'), i),
          post: set('j', b('+', nm('j'), I(1))),
          body: [iff(same(vecGet(v, i), vecGet(v, nm('j'))),
            [{ kind: 'return', values: [b('+', i, I(1))] }])],
        }]),
        { kind: 'return', values: [I(0)] },
      ],
    };
  }
  if (name === 'r_in1') {
    /* `一格数 %in% t` —— 回的是**三态标量**（那一格能直接进 `if`）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: REAL }, { name: 'w', type: RVEC }],
      ret: RLGL1,
      body: [
        letI('m', vecLen(w)),
        forTo('j', nm('m'), [iff(same(nm('a'), vecGet(w, j)), [ret(R(1))])]),
        ret(R(0)),
      ],
    };
  }
  if (name === 'r_unique' || name === 'r_dup') {
    /* `unique` 留**第一次出现**的那些（次序不变）；`duplicated` 回"这一格前面见过没有"。 */
    const uniq = name === 'r_unique';
    return {
      kind: 'fn',
      name,
      params: P1,
      ret: uniq ? RVEC : RLGL,
      body: [
        letI('n', vecLen(v)),
        ...vecNewAs('o', nm('n')),
        letI('k', I(0)),
        forTo('i', nm('n'), [
          letB('seen', { kind: 'bool', value: false }),
          forTo('j', i, [iff(same(vecGet(v, i), vecGet(v, j)), [set('seen', { kind: 'bool', value: true }), { kind: 'break' }])]),
          uniq
            ? iff({ kind: 'unop', op: '!', operand: nm('seen') }, [vecSet(o, nm('k'), vecGet(v, i)), set('k', b('+', nm('k'), I(1)))])
            : vecSet(o, i, { kind: 'ternary', cond: nm('seen'), then: R(1), else_: R(0) }),
        ]),
        ...(uniq ? [setLen(nm('k'))] : []),
        ret(o),
      ],
    };
  }
  /* `union` / `intersect` / `setdiff` —— 三格都**去重**（R 的文档），次序按 a 再按 b。 */
  const kind = name === 'r_union' ? 'u' : (name === 'r_intersect' ? 'i' : 'd');
  const inW = cal('r_in1', vecGet(v, i), w);
  const takeA = kind === 'u' ? null
    : (kind === 'i' ? b('!=', inW, R(0)) : b('==', inW, R(0)));
  const pushIfNew = (src, idx) => [
    letB('seen', { kind: 'bool', value: false }),
    forTo('j', nm('k'), [iff(same(vecGet(src, idx), vecGet(o, j)), [set('seen', { kind: 'bool', value: true }), { kind: 'break' }])]),
    iff({ kind: 'unop', op: '!', operand: nm('seen') }, [
      vecSet(o, nm('k'), vecGet(src, idx)),
      set('k', b('+', nm('k'), I(1))),
    ]),
  ];
  return {
    kind: 'fn',
    name,
    params: P2,
    ret: RVEC,
    body: [
      letI('nv', vecLen(v)),
      letI('nw', vecLen(w)),
      ...vecNewAs('o', kind === 'u' ? b('+', nm('nv'), nm('nw')) : nm('nv')),
      letI('k', I(0)),
      forTo('i', nm('nv'), takeA === null
        ? pushIfNew(v, i)
        : [iff(takeA, pushIfNew(v, i))]),
      ...(kind === 'u' ? [forTo('i', nm('nw'), pushIfNew(w, i))] : []),
      setLen(nm('k')),
      ret(o),
    ],
  };
}

function strvFnDecl(name) {
  const nm = (n2) => ({ kind: 'name', name: n2 });
  const I = (v) => ({ kind: 'int', value: v });
  const S = (v) => ({ kind: 'string', value: v });
  const letI = (n2, init) => ({ kind: 'let', name: n2, type: INT, init });
  const letS = (n2, init) => ({ kind: 'let', name: n2, type: STR, init });
  const set = (n2, v) => ({ kind: 'assign', target: nm(n2), value: v });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const wr = (s) => ({ kind: 'builtin-stmt', name: 'write', args: [s] });
  const v = nm('v');
  const i = nm('i');
  const P = [{ name: 'v', type: RSTRV }];
  const loop = (body, upto) => ({
    kind: 'for',
    init: letI('i', I(0)),
    cond: b('<', i, upto),
    post: set('i', b('+', i, I(1))),
    body,
  });
  const pad = (s, w) => ({
    kind: 'ternary',
    cond: b('<', call1('slen', s), w),
    then: call1('srep', S(' '), b('-', w, call1('slen', s))),
    else_: S(''),
  });

  if (BASE_SV.has(name)) {
    /**
     * base 的那四条字符向量常量（`letters` / `LETTERS` / `month.name` / `month.abb`）。
     * 一条 `(arr string)` 造出来就 `apush` 满 —— 每用一次现造一条：R 那边它们是变量
     * （能被 `letters <- …` 盖掉），所以"每次拿到的是一条新的"与 R 的值语义同解。
     */
    return {
      kind: 'fn',
      name,
      params: [],
      ret: RSTRV,
      body: [
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        ...BASE_SV.get(name).map((w) => ({
          kind: 'builtin-stmt', name: 'apush', args: [nm('o'), S(w)],
        })),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_strrep_v') {
    /** `strrep(v, n)` 在字符向量上逐元素（`(srep …)` 是现成的算子）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'k', type: INT }],
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        loop([{
          kind: 'builtin-stmt',
          name: 'apush',
          args: [nm('o'), call1('srep', svGet(v, i), nm('k'))],
        }], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_as_str_v' || name === 'r_as_str_lv') {
    /**
     * `as.character(向量)` —— 出一条字符向量。数那一档按**15 位有效数字**
     * （`coerce.c` 的口径，与 `paste` 同一条），逻辑那一档出 `"TRUE"` / `"FALSE"`。
     *
     * **碰上缺失就当场报**：R 那边出的是 `NA_character_`（印出来不带引号），
     * 而这一档没有带缺失的串（SPEC 第四节第 11 条）—— 印成 `"NA"` 差两个引号。
     */
    const lgl = name === 'r_as_str_lv';
    const el = vecGet(v, i);
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: lgl ? RLGL : RVEC }],
      ret: RSTRV,
      body: [
        letI('n', vecLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        loop([
          iff(naQ(el), [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{
              kind: 'string',
              value: 'as.character(): 这条向量里有 NA —— R 出的是 NA_character_（印出来不带引号），'
                + '而这一档没有带缺失的串（见 ext/r/SPEC.md 第四节第 11 条）',
            }],
          }]),
          {
            kind: 'builtin-stmt',
            name: 'apush',
            args: [nm('o'), lgl
              ? { kind: 'call', fn: { kind: 'name', name: useFn('r_lgl_str') }, args: [el] }
              : { kind: 'call', fn: { kind: 'name', name: useFn(NUM_STR) }, args: [el, I(15)] }],
          },
        ], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_sort_str' || name === 'r_order_str') {
    /**
     * 字符向量的 `sort(v, method = "radix")` / `order(v, method = "radix")`。
     *
     * **为什么只接 `radix` 这一档**：R 的默认排序按 locale 的排序规则（`Scollate`，
     * 量出来这台机器 `LC_COLLATE` 是 `zh_CN`，`sort(c("pear","apple","Banana"))` 出
     * `apple Banana pear`）—— 那要 ICU 那一套。而 `method = "radix"` 是 R 自己
     * **明说在 C locale 下比**的那一档（`?sort`），量出来正是**按字节**：
     * `sort(c("pear","apple","Banana"), method="radix")` 出 `Banana apple pear`。
     * 按字节比我们答得准，所以接这一档、默认那一档照旧当场报。
     *
     * 比较用方言的 `<`（`(bin "<" 串 串)`）。**只管 ASCII**：JS 那侧 `<` 比的是 UTF-16
     * 码元、C 那侧是字节，非 ASCII 上这两种次序会分家 —— 所以 `sort` / `order` 进了
     * `BYTEWISE` 那张表（串字面量里有非 ASCII 就在调用点当场报）。
     *
     * 排法与数那一侧同一条（Knuth 的 gap 序列）；`order` 排的是**下标**，同值按原下标
     * 分先后（于是次序唯一 —— 与 R 的 radix 稳定排序同解）。
     */
    const ord = name === 'r_order_str';
    const g = nm('g');
    const j = nm('j');
    const t2 = ord ? nm('ti') : nm('ts');
    const oAt = (e) => (ord ? vecGet(nm('o'), e) : svGet(nm('o'), e));
    /* 要比的那一格：`order` 手上是下标（按 double 存），要先取出串来。 */
    const key = (e) => (ord ? svGet(v, call1('toint', e)) : e);
    const less = b('||', b('<', key(t2), key(oAt(b('-', j, g)))),
      b('&&', b('==', key(t2), key(oAt(b('-', j, g)))),
        ord ? b('<', t2, oAt(b('-', j, g))) : { kind: 'bool', value: false }));
    return {
      kind: 'fn',
      name,
      params: P,
      ret: ord ? RIVEC : RSTRV,
      body: [
        letI('n', svLen(v)),
        ...(ord
          ? [...vecNewAs('o', nm('n')),
            loop([vecSet(nm('o'), i, call1('toreal', i))], nm('n'))]
          : [{ kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
            loop([{ kind: 'builtin-stmt', name: 'apush', args: [nm('o'), svGet(v, i)] }], nm('n'))]),
        letI('g', I(1)),
        {
          kind: 'while',
          cond: b('<', b('*', g, I(3)), nm('n')),
          body: [set('g', b('+', b('*', g, I(3)), I(1)))],
        },
        {
          kind: 'while',
          cond: b('>=', g, I(1)),
          body: [
            {
              kind: 'for',
              init: letI('i2', g),
              cond: b('<', nm('i2'), nm('n')),
              post: set('i2', b('+', nm('i2'), I(1))),
              body: [
                ord
                  ? { kind: 'let', name: 'ti', type: REAL, init: vecGet(nm('o'), nm('i2')) }
                  : { kind: 'let', name: 'ts', type: STR, init: svGet(nm('o'), nm('i2')) },
                letI('j', nm('i2')),
                {
                  kind: 'while',
                  cond: b('&&', b('>=', j, g), less),
                  body: [
                    ord
                      ? vecSet(nm('o'), j, vecGet(nm('o'), b('-', j, g)))
                      : { kind: 'assign', target: svGet(nm('o'), j), value: svGet(nm('o'), b('-', j, g)) },
                    set('j', b('-', j, g)),
                  ],
                },
                ord
                  ? vecSet(nm('o'), j, t2)
                  : { kind: 'assign', target: svGet(nm('o'), j), value: t2 },
              ],
            },
            set('g', b('/', b('-', g, I(1)), I(3))),
          ],
        },
        /* `order` 内部 0 起，交出去要 1 起（R 的 `order` 回的是位置）。 */
        ...(ord ? [loop([vecSet(nm('o'), i, b('+', vecGet(nm('o'), i), { kind: 'real', value: 1 }))], nm('n'))] : []),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_sv1') {
    /** 一格串摆成长度 1 的字符向量（与数那一侧的 `r_vec1` 同一个用处）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: STR }],
      ret: RSTRV,
      body: [
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        { kind: 'builtin-stmt', name: 'apush', args: [nm('o'), nm('a')] },
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_any_dup_str') {
    /**
     * `anyDuplicated(v)` 在字符向量上 —— R 回的是**第一格重复元素的位置**（1 起），
     * 一格重复都没有回 `0`（量出来 `anyDuplicated(c(1,2,1))` 是 3）。
     * 与 `duplicated` 同一条：只要"相等"，不要 collation。
     */
    return {
      kind: 'fn',
      name,
      params: P,
      ret: INT,
      body: [
        letI('n', svLen(v)),
        loop([{
          kind: 'for',
          init: letI('j', I(0)),
          cond: b('<', nm('j'), i),
          post: set('j', b('+', nm('j'), I(1))),
          body: [iff(b('==', svGet(v, i), svGet(v, nm('j'))),
            [{ kind: 'return', values: [b('+', i, I(1))] }])],
        }], nm('n')),
        { kind: 'return', values: [I(0)] },
      ],
    };
  }
  if (name === 'r_uniq_str' || name === 'r_dup_str') {
    /**
     * 字符向量上的 `unique` / `duplicated` —— **只要"相等"，不要 collation**。
     *
     * 这是这一族与 `sort` / `order` 的分水岭：排序要 R 的 locale 排序规则
     * （`Scollate`，见第四节第 12 条），而"这两个串是不是同一个"是逐字节的、与 locale
     * 无关 —— 所以这几格接得住，排序那两格照旧当场报。
     */
    const uniq = name === 'r_uniq_str';
    const seen = nm('sn');
    return {
      kind: 'fn',
      name,
      params: P,
      ret: uniq ? RSTRV : RLGL,
      body: [
        letI('n', svLen(v)),
        ...(uniq
          ? [{ kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) }]
          : vecNewAs('o', nm('n'))),
        loop([
          { kind: 'let', name: 'sn', type: BOOL, init: { kind: 'bool', value: false } },
          {
            kind: 'for',
            init: letI('j', I(0)),
            cond: b('<', nm('j'), i),
            post: set('j', b('+', nm('j'), I(1))),
            body: [iff(b('==', svGet(v, i), svGet(v, nm('j'))),
              [{ kind: 'assign', target: seen, value: { kind: 'bool', value: true } }])],
          },
          uniq
            ? iff({ kind: 'unop', op: '!', operand: seen },
              [{ kind: 'builtin-stmt', name: 'apush', args: [nm('o'), svGet(v, i)] }])
            : vecSet(nm('o'), i, { kind: 'ternary', cond: seen, then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } }),
        ], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_match_str' || name === 'r_in_str') {
    /** `match(v, w)` 回位置（找不到 `NA`）、`v %in% w` 回真假 —— 都只用"相等"。 */
    const mat = name === 'r_match_str';
    const w = nm('w');
    const hit = nm('h');
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'w', type: RSTRV }],
      ret: mat ? RIVEC : RLGL,
      body: [
        letI('n', svLen(v)),
        letI('m', svLen(w)),
        ...vecNewAs('o', nm('n')),
        loop([
          letI('h', I(-1)),
          {
            kind: 'for',
            init: letI('j', I(0)),
            cond: b('&&', b('<', nm('j'), nm('m')), b('<', hit, I(0))),
            post: set('j', b('+', nm('j'), I(1))),
            body: [iff(b('==', svGet(v, i), svGet(w, nm('j'))), [set('h', nm('j'))])],
          },
          iff(b('<', hit, I(0)),
            [vecSet(nm('o'), i, mat
              ? { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }
              : { kind: 'real', value: 0 })],
            [vecSet(nm('o'), i, mat
              ? call1('toreal', b('+', hit, I(1)))
              : { kind: 'real', value: 1 })]),
        ], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_in1_str') {
    /** `一格串 %in% w` —— 回真假（那一格能直接进 `if`）。 */
    const w = nm('w');
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: STR }, { name: 'w', type: RSTRV }],
      ret: BOOL,
      body: [
        letI('m', svLen(w)),
        loop([iff(b('==', nm('a'), svGet(w, i)), [{ kind: 'return', values: [{ kind: 'bool', value: true }] }])], nm('m')),
        { kind: 'return', values: [{ kind: 'bool', value: false }] },
      ],
    };
  }
  if (name === 'r_union_str' || name === 'r_isect_str' || name === 'r_sdiff_str') {
    /**
     * 三格集合运算在字符向量上。R 的口径（量出来的）：**都先去重、按出现次序**——
     * `union` 是"第一条的去重 + 第二条里没在第一条出现过的"、`intersect` 是"第一条里
     * 也在第二条里的（去重）"、`setdiff` 是"第一条里不在第二条里的（去重）"。
     */
    const w = nm('w');
    const inW = (e, tbl) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_in1_str') }, args: [e, tbl] });
    const out = nm('o');
    const push = (e) => ({ kind: 'builtin-stmt', name: 'apush', args: [out, e] });
    const both = name === 'r_union_str';
    const keep = name === 'r_isect_str'
      ? (e) => inW(e, w)
      : (e) => ({ kind: 'unop', op: '!', operand: inW(e, w) });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'w', type: RSTRV }],
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        /* 第一条：去重（用 `o` 自己当"见过没有"的表）+ 那一格该不该留。 */
        loop([iff(b('&&', { kind: 'unop', op: '!', operand: inW(svGet(v, i), out) },
          both ? { kind: 'bool', value: true } : keep(svGet(v, i))), [push(svGet(v, i))])], nm('n')),
        ...(both ? [
          letI('m', svLen(w)),
          {
            kind: 'for',
            init: letI('j', I(0)),
            cond: b('<', nm('j'), nm('m')),
            post: set('j', b('+', nm('j'), I(1))),
            body: [iff({ kind: 'unop', op: '!', operand: inW(svGet(w, nm('j')), out) },
              [push(svGet(w, nm('j')))])],
          },
        ] : []),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_head_str' || name === 'r_tail_str') {
    /** 字符向量上的 `head` / `tail` —— 按下标挑，与 collation 无关。 */
    const kk = nm('k');
    const from = name === 'r_head_str' ? I(0) : b('-', nm('n'), kk);
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'k', type: INT }],
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        letI('c', kk),
        iff(b('>', nm('c'), nm('n')), [set('c', nm('n'))]),
        iff(b('<', nm('c'), I(0)), [set('c', I(0))]),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        letI('a', name === 'r_head_str' ? I(0) : b('-', nm('n'), nm('c'))),
        {
          kind: 'for',
          init: letI('i', I(0)),
          cond: b('<', i, nm('c')),
          post: set('i', b('+', i, I(1))),
          body: [{ kind: 'builtin-stmt', name: 'apush', args: [nm('o'), svGet(v, b('+', nm('a'), i))] }],
        },
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_at_name' || name === 'r_nm_at') {
    /* `v["a"]` —— 在名字那一条里找那个名字，回值（`r_at_name`）或者回"印出来的那个名字"
       （`r_nm_at`）。找不到时 R 印的是 `<NA>` / `NA`（量出来的，`Rscript`，2026-09-25），
       所以这儿一格回 `NA`、一格回 `"<NA>"` —— 不是当场报：那是 R 自己的答案。 */
    const val = name === 'r_at_name';
    return {
      kind: 'fn',
      name,
      params: val
        ? [{ name: 'v', type: RVEC }, { name: 'ns', type: RSTRV }, { name: 'k', type: STR }]
        : [{ name: 'ns', type: RSTRV }, { name: 'k', type: STR }],
      ret: val ? REAL : STR,
      body: [
        letI('n', svLen(nm('ns'))),
        loop([
          iff(b('==', svGet(nm('ns'), i), nm('k')), [{
            kind: 'return',
            values: [val ? vecGet(v, i) : nm('k')],
          }]),
        ], nm('n')),
        { kind: 'return', values: [val ? lglCall('r_na') : S('<NA>')] },
      ],
    };
  }
  if (name === 'r_gsub') {
    /* 一格串上按**定串**换：`all` 是 0 就只换第一处（`sub`），1 是全换（`gsub`）。
       从 `pos` 往后找用的是"把剩下那段切出来再 `sfind`" —— 方言的 `sfind` 只从头找。
       R 的口径：不重叠、从左往右（`gsub("aa", "b", "aaaa")` 是 `"bb"`，量出来的）。 */
    const s = nm('s');
    const p = nm('p');
    const pos = nm('pos');
    return {
      kind: 'fn',
      name,
      params: [
        { name: 's', type: STR }, { name: 'p', type: STR },
        { name: 'r', type: STR }, { name: 'all', type: INT },
      ],
      ret: STR,
      body: [
        letI('n', call1('slen', s)),
        letI('m', call1('slen', p)),
        letS('o', S('')),
        letI('pos', I(0)),
        {
          kind: 'while',
          cond: b('<=', b('+', pos, nm('m')), nm('n')),
          body: [
            letI('k', call1('sfind', call1('ssub', s, pos, b('-', nm('n'), pos)), p)),
            iff(b('<', nm('k'), I(0)), [{ kind: 'break' }]),
            set('o', b('+', b('+', nm('o'), call1('ssub', s, pos, nm('k'))), nm('r'))),
            set('pos', b('+', b('+', pos, nm('k')), nm('m'))),
            iff(b('==', nm('all'), I(0)), [{ kind: 'break' }]),
          ],
        },
        { kind: 'return', values: [b('+', nm('o'), call1('ssub', s, pos, b('-', nm('n'), pos)))] },
      ],
    };
  }
  if (name === 'r_gsub_v') {
    return {
      kind: 'fn',
      name,
      params: [
        { name: 'v', type: RSTRV }, { name: 'p', type: STR },
        { name: 'r', type: STR }, { name: 'all', type: INT },
      ],
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), nm('n')) },
        loop([{
          kind: 'assign',
          target: svGet(nm('o'), i),
          value: {
            kind: 'call',
            fn: { kind: 'name', name: useFn('r_gsub') },
            args: [svGet(v, i), nm('p'), nm('r'), nm('all')],
          },
        }], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_grepl_v') {
    /* 逐元素"里头有没有这一段"→ 一条**逻辑**向量（`(ptr real)` 上的 1 / 0，见 `RLGL`）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'p', type: STR }],
      ret: RLGL,
      body: [
        letI('n', svLen(v)),
        ...vecNewAs('o', nm('n')),
        loop([vecSet(nm('o'), i, {
          kind: 'ternary',
          cond: b('>=', call1('sfind', svGet(v, i), nm('p')), I(0)),
          then: { kind: 'real', value: 1 },
          else_: { kind: 'real', value: 0 },
        })], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_grep_i' || name === 'r_grep_s') {
    /* `grep(p, v)` 回**位置**（1 起）、`grep(p, v, value = TRUE)` 回那几格元素本身。
       两个都是"先按上界开、填完改长度"（槽 0 是长度 / `anew` 那条按 `k` 截）。 */
    const idx = name === 'r_grep_i';
    const hit = b('>=', call1('sfind', svGet(v, i), nm('p')), I(0));
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'p', type: STR }],
      ret: idx ? RIVEC : RSTRV,
      body: [
        letI('n', svLen(v)),
        ...(idx
          ? vecNewAs('o', nm('n'))
          : [{ kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) }]),
        letI('k', I(0)),
        loop([iff(hit, idx
          ? [
            vecSet(nm('o'), nm('k'), call1('toreal', b('+', i, I(1)))),
            set('k', b('+', nm('k'), I(1))),
          ]
          : [{ kind: 'builtin-stmt', name: 'apush', args: [nm('o'), svGet(v, i)] }])], nm('n')),
        ...(idx
          ? [{
            kind: 'assign',
            target: { kind: 'deref', expr: nm('o') },
            value: call1('toreal', nm('k')),
          }]
          : []),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_rep_str') {
    /* `rep(字符向量, times, each)` —— 与 `r_rep_v` 同形，只是落在 `(arr string)` 上。
       一格串（`rep("ab", 3)`）也走这儿：调用点先摆成一条长度 1 的字符向量。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'k', type: INT }, { name: 'e', type: INT }],
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        {
          kind: 'for',
          init: letI('t', I(0)),
          cond: b('<', nm('t'), nm('k')),
          post: set('t', b('+', nm('t'), I(1))),
          body: [loop([{
            kind: 'for',
            init: letI('q', I(0)),
            cond: b('<', nm('q'), nm('e')),
            post: set('q', b('+', nm('q'), I(1))),
            body: [{ kind: 'builtin-stmt', name: 'apush', args: [nm('o'), svGet(v, i)] }],
          }], nm('n'))],
        },
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_ifelse_s') {
    /* `ifelse(test, "y", "n")` —— test 是逻辑向量，两支是串，出一条字符向量。
       test 里有 `NA` 时 R 挑出一格 `NA_character_`，这一档没有那种值 —— **当场停下来**
       （与 `r_mask_str` 同一条：不给一个看着像对的答案）。 */
    const at = vecGet(nm('p'), i);
    return {
      kind: 'fn',
      name,
      params: [
        { name: 'p', type: RLGL }, { name: 'y', type: STR }, { name: 'z', type: STR },
      ],
      ret: RSTRV,
      body: [
        letI('n', vecLen(nm('p'))),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), nm('n')) },
        loop([
          {
            kind: 'if',
            cond: { kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [at] },
            then: [{
              kind: 'builtin-stmt',
              name: 'fail',
              args: [{ kind: 'string', value: 'NA in ifelse() over strings: NA_character_ 还没有' }],
            }],
            else_: null,
          },
          {
            kind: 'assign',
            target: svGet(nm('o'), i),
            value: {
              kind: 'ternary',
              cond: b('!=', at, { kind: 'real', value: 0 }),
              then: nm('y'),
              else_: nm('z'),
            },
          },
        ], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_substr_v' || name === 'r_trim_v' || name === 'r_starts_v' || name === 'r_ends_v'
      || name === 'r_chartr_v') {
    /* 串那一族在**字符向量**上逐元素（`substr(v, 1, 3)` / `trimws(v)` /
       `startsWith(v, "a")` / `chartr(o, n, v)`）—— 每一格转给标量那一版，出来的是另一条向量。
       `startsWith` / `endsWith` 出的是**逻辑**向量（`(ptr real)` 上的 1 / 0，见 `RLGL`）。 */
    const lgl = name === 'r_starts_v' || name === 'r_ends_v';
    const one = {
      r_substr_v: 'r_substr', r_trim_v: 'r_trim', r_starts_v: 'r_starts', r_ends_v: 'r_ends',
      r_chartr_v: 'r_chartr',
    }[name];
    const args = {
      r_substr_v: () => [svGet(v, i), nm('a'), nm('z')],
      /* `trimws` 的第二格是"哪一头"（0 两头 / 1 左 / 2 右），原样传下去。 */
      r_trim_v: () => [svGet(v, i), nm('w')],
      /* `chartr` 的两张表在前头（与标量那一版同序）。 */
      r_chartr_v: () => [nm('on'), nm('nw'), svGet(v, i)],
    }[name] ?? (() => [svGet(v, i), nm('t')]);
    const params = [{ name: 'v', type: RSTRV }];
    if (name === 'r_substr_v') params.push({ name: 'a', type: INT }, { name: 'z', type: INT });
    if (name === 'r_trim_v') params.push({ name: 'w', type: INT });
    if (name === 'r_chartr_v') params.push({ name: 'on', type: STR }, { name: 'nw', type: STR });
    if (lgl) params.push({ name: 't', type: STR });
    const el = { kind: 'call', fn: { kind: 'name', name: useFn(one) }, args: args() };
    return {
      kind: 'fn',
      name,
      params,
      ret: lgl ? RLGL : RSTRV,
      body: [
        letI('n', svLen(v)),
        ...(lgl
          ? vecNewAs('o', nm('n'))
          : [{ kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), nm('n')) }]),
        loop([lgl
          ? vecSet(nm('o'), i, { kind: 'ternary', cond: el, then: { kind: 'real', value: 1 }, else_: { kind: 'real', value: 0 } })
          : { kind: 'assign', target: svGet(nm('o'), i), value: el }], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_cat_str') {
    /* `cat(labels, sep=…)` —— 元素**不带引号**（那是 `print` 的事），按 `sep` 连起来。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'sep', type: STR }],
      ret: { kind: 'void' },
      body: [
        letI('n', svLen(v)),
        loop([
          iff(b('>', i, I(0)), [wr(nm('sep'))]),
          wr(svGet(v, i)),
        ], nm('n')),
      ],
    };
  }
  if (name === 'r_join_str') {
    /* `paste(labels, collapse=s)` —— 连成一格串。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'sep', type: STR }],
      ret: STR,
      body: [
        letI('n', svLen(v)),
        letS('o', S('')),
        loop([
          iff(b('>', i, I(0)), [set('o', b('+', nm('o'), nm('sep')))]),
          set('o', b('+', nm('o'), svGet(v, i))),
        ], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_rev_str') {
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), nm('n')) },
        loop([{
          kind: 'assign',
          target: svGet(nm('o'), i),
          value: svGet(v, b('-', b('-', nm('n'), i), I(1))),
        }], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_nchar_v') {
    /* `nchar(字符向量)` —— 逐元素出一条**数值**向量（两种存法之间过一趟）。 */
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        letI('n', svLen(v)),
        ...vecNewAs('o', nm('n')),
        loop([vecSet(nm('o'), i, call1('toreal', call1('slen', svGet(v, i))))], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_upper_v' || name === 'r_lower_v') {
    const one = name === 'r_upper_v'
      ? call1('supper', svGet(v, i))
      : { kind: 'call', fn: { kind: 'name', name: useFn('r_lower') }, args: [svGet(v, i)] };
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), nm('n')) },
        loop([{ kind: 'assign', target: svGet(nm('o'), i), value: one }], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_pick_str' || name === 'r_mask_str') {
    /* `labels[c(1,3)]`（按位置挑）与 `labels[nchar(labels) > 2]`（按掩码挑）。
       两处与 R 不同，都明写在 SPEC：越界在 R 里出 `NA_character_`，这儿 `(aget …)`
       当场报（我们没有串的缺失）；掩码里的 `NA` 在 R 里也挑出一格 `NA`，这儿停下来。 */
    const p = { kind: 'name', name: 'p' };
    const cnt = nm('k');
    if (name === 'r_pick_str') {
      /* 与数值那一侧的 `r_vec_pick` 是**同三条规矩**（正数挑、0 跳过、负数丢、混着报）——
         只是抄的是 `(arr string)`。判正负是运行期的事，所以那三条在这儿也写一遍。 */
      const jj = nm('j');
      const at2 = vecGet(p, jj);
      const forJ2 = (upto, body) => ({
        kind: 'for', init: letI('j', I(0)), cond: b('<', jj, upto), post: set('j', b('+', jj, I(1))), body,
      });
      return {
        kind: 'fn',
        name,
        params: [{ name: 'v', type: RSTRV }, { name: 'p', type: RVEC }],
        ret: RSTRV,
        body: [
          letI('m', vecLen(p)),
          letI('n', svLen(v)),
          letI('nneg', I(0)),
          letI('npos', I(0)),
          forJ2(nm('m'), [
            iff(b('<', at2, { kind: 'real', value: 0 }),
              [set('nneg', b('+', nm('nneg'), I(1)))],
              [iff(b('>', at2, { kind: 'real', value: 0 }), [set('npos', b('+', nm('npos'), I(1)))])]),
          ]),
          iff(b('&&', b('>', nm('nneg'), I(0)), b('>', nm('npos'), I(0))), [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{ kind: 'string', value: "can't mix positive and negative subscripts" }],
          }]),
          { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
          iff(b('>', nm('nneg'), I(0)), [
            ...vecNewAs('kp', nm('n')),
            loop([vecSet(nm('kp'), i, { kind: 'real', value: 1 })], nm('n')),
            forJ2(nm('m'), [
              letI('q', b('-', I(0), call1('toint', at2))),
              iff(b('&&', b('>=', nm('q'), I(1)), b('<=', nm('q'), nm('n'))),
                [vecSet(nm('kp'), b('-', nm('q'), I(1)), { kind: 'real', value: 0 })]),
            ]),
            loop([iff(b('!=', vecGet(nm('kp'), i), { kind: 'real', value: 0 }),
              [{ kind: 'builtin-stmt', name: 'apush', args: [nm('o'), svGet(v, i)] }])], nm('n')),
            { kind: 'return', values: [nm('o')] },
          ]),
          forJ2(nm('m'), [iff(b('!=', at2, { kind: 'real', value: 0 }), [{
            kind: 'builtin-stmt',
            name: 'apush',
            args: [nm('o'), svGet(v, b('-', call1('toint', at2), I(1)))],
          }])]),
          { kind: 'return', values: [nm('o')] },
        ],
      };
    }
    const at = vecGet(p, b('%', i, nm('m')));
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RSTRV }, { name: 'p', type: RLGL }],
      ret: RSTRV,
      body: [
        letI('n', svLen(v)),
        letI('m', vecLen(p)),
        letI('k', I(0)),
        loop([
          {
            kind: 'if',
            cond: { kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [at] },
            then: [{
              kind: 'builtin-stmt',
              name: 'fail',
              args: [{ kind: 'string', value: 'NA in a character-vector mask: NA_character_ 还没有' }],
            }],
            else_: null,
          },
          { kind: 'if', cond: b('!=', at, { kind: 'real', value: 0 }), then: [set('k', b('+', cnt, I(1)))], else_: null },
        ], nm('n')),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), cnt) },
        set('k', I(0)),
        loop([{
          kind: 'if',
          cond: b('!=', at, { kind: 'real', value: 0 }),
          then: [
            { kind: 'assign', target: svGet(nm('o'), cnt), value: svGet(v, i) },
            set('k', b('+', cnt, I(1))),
          ],
          else_: null,
        }], nm('n')),
        { kind: 'return', values: [nm('o')] },
      ],
    };
  }
  if (name === 'r_split') {
    /* `strsplit(s, sep)[[1]]` —— 按一段**定串**切开。R 的三条口径（量出来的）：
       空串进 → 零长；`sep` 是空串 → 一格一个字符；**末尾那格空串不要**
       （`strsplit("a,b,", ",")` 是 `"a" "b"`，不是 `"a" "b" ""`）。
       R 那边 `split` 默认是**正则**，所以这儿只收"没有正则元字符的定串"或 `fixed = TRUE`
       （那一问在 `callOf` 里编译期就判了）。 */
    const s = nm('s');
    const sep = nm('sep');
    const o = nm('o');
    const pos = nm('p');
    const rest = call1('ssub', s, pos, b('-', nm('n'), pos));
    return {
      kind: 'fn',
      name,
      params: [{ name: 's', type: STR }, { name: 'sep', type: STR }],
      ret: RSTRV,
      body: [
        letI('n', call1('slen', s)),
        letI('m', call1('slen', sep)),
        { kind: 'let', name: 'o', type: RSTRV, init: call1('anew', tyArg(RSTRV), I(0)) },
        iff(b('==', nm('n'), I(0)), [{ kind: 'return', values: [o] }]),
        iff(b('==', nm('m'), I(0)), [
          loop([{ kind: 'builtin-stmt', name: 'apush', args: [o, call1('ssub', s, i, I(1))] }], nm('n')),
          { kind: 'return', values: [o] },
        ]),
        letI('p', I(0)),
        {
          kind: 'while',
          cond: { kind: 'bool', value: true },
          body: [
            { kind: 'let', name: 'r', type: STR, init: rest },
            letI('k', call1('sfind', nm('r'), sep)),
            iff(b('<', nm('k'), I(0)), [
              { kind: 'builtin-stmt', name: 'apush', args: [o, nm('r')] },
              { kind: 'break' },
            ]),
            { kind: 'builtin-stmt', name: 'apush', args: [o, call1('ssub', nm('r'), I(0), nm('k'))] },
            set('p', b('+', b('+', pos, nm('k')), nm('m'))),
            /* 末尾正好切在最后 —— R 不给那一格空串。 */
            iff(b('>=', pos, nm('n')), [{ kind: 'break' }]),
          ],
        },
        { kind: 'return', values: [o] },
      ],
    };
  }
  /* `r_print_str` —— 共用一套宽 + `[k]` 标号 + 80 列折行（与 `printFnDecl` 的那一圈同形，
     只是这儿**左对齐**、而且元素文本是"加一对引号"）。 */
  const quoted = (k) => b('+', b('+', S('"'), svGet(v, k)), S('"'));
  return {
    kind: 'fn',
    name,
    params: P,
    ret: { kind: 'void' },
    body: [
      letI('n', svLen(v)),
      /* 零长向量 R 印类型名（`character(0)`）—— 与 `numeric(0)` / `logical(0)` 同一条。 */
      iff(b('==', nm('n'), I(0)), [wr(S('character(0)\n')), { kind: 'return', values: [] }]),
      letI('w', I(0)),
      loop([
        letI('q', b('+', call1('slen', svGet(v, i)), I(2))),
        iff(b('>', nm('q'), nm('w')), [set('w', nm('q'))]),
      ], nm('n')),
      letS('lab', b('+', b('+', S('['), call1('tostr', nm('n'))), S(']'))),
      letI('lw', call1('slen', nm('lab'))),
      letI('per', call1('toint', call1('rmath', { kind: 'strlit', value: 'floor' }, b('/',
        call1('toreal', b('-', I(80), nm('lw'))), call1('toreal', b('+', nm('w'), I(1))))))),
      iff(b('<', nm('per'), I(1)), [set('per', I(1))]),
      letI('i', I(0)),
      {
        kind: 'while',
        cond: b('<', i, nm('n')),
        body: [
          letS('l2', b('+', b('+', S('['), call1('tostr', b('+', i, I(1)))), S(']'))),
          wr(pad(nm('l2'), nm('lw'))),
          wr(nm('l2')),
          letI('j', i),
          {
            kind: 'while',
            cond: b('&&', b('<', nm('j'), nm('n')), b('<', nm('j'), b('+', i, nm('per')))),
            body: [
              letS('s', quoted(nm('j'))),
              wr(S(' ')),
              wr(nm('s')),
              wr(pad(nm('s'), nm('w'))),
              set('j', b('+', nm('j'), I(1))),
            ],
          },
          wr(S('\n')),
          set('i', b('+', i, nm('per'))),
        ],
      },
    ],
  };
}

/**
 * `scientific()` 那一半（`src/main/format.c`）—— 一格 double 要印成什么形状，
 * 三个数就够说：**符号**、**小数点左边几位**（`left`，已经把 `roundingwidens` 折进去了）、
 * **有效数字几位**（`nsig`）。写进 `p` 的 0 / 1 / 2 三格。
 *
 * 为什么是"写进指针"而不是回一格值：`print` 要**一整条向量共用一套宽度**
 * （R 的 `formatReal` 就是先把每格的这三个数取极值、再挑一次），所以这一半必须能
 * 单独调、而且一趟给三个数。方言里函数只回一格值 —— 那就照 `r_na` 那条先例走指针。
 *
 * 两处口径差别（量过 132 个值逐字节对 `Rscript`，含 `.Machine$double.xmax` 与 5e-324）：
 *
 *   * 那份 C 在 macOS 上走 **long double**（80 位）缩放，这儿只有 double。缩放因子
 *     `10^kp` 在 |kp| <= 22 上是精确值，所以两支同结果；再往外 R 自己也退回 `pow()`。
 *   * `nearbyintl` 是**就近取偶**，方言里没有这一格（`rmath "round"` 是 C 的离零舍入），
 *     所以按 `floor` + 小数部分手写一遍 —— `1000000.5` 就压在这儿：取偶给 `1000000`
 *     （`nsig` 是 1、印 `1e+06`），离零舍入会给 `1000001`（`nsig` 是 7、印 `1000001`）。
 */
function sciFnDecl() {
  const KP_MAX = 22;             /* 那张幂次表在 double 上的上界（`format.c` 的 tbl） */
  const nm = (name) => ({ kind: 'name', name });
  const R = (value) => ({ kind: 'real', value });
  const I = (value) => ({ kind: 'int', value });
  const rm = (fn, ...args) => call1('rmath', { kind: 'strlit', value: fn }, ...args);
  const p10 = (e) => rm('pow', R(10), call1('toreal', e));
  const letR = (name, init) => ({ kind: 'let', name, type: REAL, init });
  const letI = (name, init) => ({ kind: 'let', name, type: INT, init });
  const set = (name, value) => ({ kind: 'assign', target: nm(name), value });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const x = nm('x');
  /* **有效数字位数是实参**：`cat` / `print` 那一档是 7（`options(digits)`），
     而 `as.character` / `paste` / `sprintf("%s")` 那一档是 **15** —— R 自己就是两套
     （`as.character(1/3)` 是 `0.333333333333333`，`cat(1/3)` 是 `0.3333333`）。 */
  const dig = nm('d');
  const slot = (i) => ({ kind: 'deref', expr: call1('padd', nm('p'), I(i)) });
  const put = (i, v) => ({ kind: 'assign', target: slot(i), value: call1('toreal', v) });
  const [r, kp, rp, fl, fr, al, nsig, kpw, rgtT, fuzz, left]
    = ['r', 'kp', 'rp', 'fl', 'fr', 'al', 'nsig', 'kpw', 'rgt_t', 'fuzz', 'left'].map(nm);
  return {
    kind: 'fn',
    name: 'r_sci',
    params: [{ name: 'x', type: REAL }, { name: 'd', type: INT }, { name: 'p', type: PTR_REAL }],
    ret: { kind: 'void' },
    body: [
      /* 零那一格：`kpower = 0, nsig = 1`（`format.c` 开头那一支） */
      iff(b('==', x, R(0)), [put(0, I(0)), put(1, I(1)), put(2, I(1)), { kind: 'return', values: [] }]),
      letI('neg', I(0)),
      iff(b('<', x, R(0)), [set('neg', I(1))]),
      letR('r', rm('fabs', x)),
      letI('kp', b('+', call1('toint', rm('floor', rm('log10', r))), b('-', I(1), dig))),
      /* |x| = alpha * 10^kpower，把 alpha 缩到 [10^(d-1), 10^d) */
      letR('rp', r),
      iff(b('&&', b('>=', kp, I(-KP_MAX)), b('<=', kp, I(KP_MAX))),
        [iff(b('>=', kp, I(0)),
          [set('rp', b('/', r, p10(kp)))],
          [set('rp', b('*', r, p10(b('-', I(0), kp))))])],
        /* 1e-308 往下只有渐进下溢能表示，所以先乘 1e+303 挪进正常数再缩（`format.c` 原话） */
        [iff(b('<=', kp, I(-308)),
          [set('rp', b('/', b('*', r, R(1e303)), p10(b('+', kp, I(303)))))],
          [set('rp', b('/', r, p10(kp)))])]),
      iff(b('<', rp, p10(b('-', dig, I(1)))), [set('rp', b('*', rp, R(10))), set('kp', b('-', kp, I(1)))]),
      /* 就近取偶（`nearbyintl`）—— rp 在这儿一定是正的，所以只按 floor 那一侧写 */
      letR('fl', rm('floor', rp)),
      letR('fr', b('-', rp, fl)),
      letR('al', fl),
      iff(b('>', fr, R(0.5)),
        [set('al', b('+', fl, R(1)))],
        [iff(b('==', fr, R(0.5)),
          [iff(b('!=', rm('fmod', fl, R(2)), R(0)), [set('al', b('+', fl, R(1)))])])]),
      /* 尾随零数掉几个，就少几位有效数字 */
      letI('nsig', dig),
      {
        kind: 'for',
        init: letI('j', I(0)),
        cond: b('<', nm('j'), dig),
        post: set('j', b('+', nm('j'), I(1))),
        body: [
          set('al', b('/', al, R(10))),
          iff(b('==', al, rm('floor', al)),
            [set('nsig', b('-', nsig, I(1)))],
            [{ kind: 'break', label: null }]),
        ],
      },
      iff(b('==', nsig, I(0)), [set('nsig', I(1)), set('kp', b('+', kp, I(1)))]),
      letI('kpw', b('+', kp, b('-', dig, I(1)))),
      /* roundingwidens：科学记数那一支会把 x 舍到 10^kpower 上去（9996 按三位是 `1e+04`，
         反而比定点的 `9996` 宽），而定点不会 —— 那时左边的位数按舍入前算 */
      letI('rgt_t', b('-', dig, kpw)),
      iff(b('<', rgtT, I(0)), [set('rgt_t', I(0))]),
      iff(b('>', rgtT, I(KP_MAX)), [set('rgt_t', I(KP_MAX))]),
      letR('fuzz', b('/', R(0.5), p10(rgtT))),
      letI('left', b('+', kpw, I(1))),
      iff(b('&&', b('&&', b('>', kpw, I(0)), b('<=', kpw, I(KP_MAX))),
        b('<', r, b('-', p10(kpw), fuzz))), [set('left', b('-', left, I(1)))]),
      put(0, nm('neg')),
      put(1, left),
      put(2, nsig),
    ],
  };
}

/**
 * `formatReal()` 那一半：手里有了一条向量（或一格数）的 `neg` / `left` 的极值 /
 * `nsig` 的极值，挑**定点还是科学记数**、各要几格宽几位小数。
 *
 * 回的是一串语句，声明 `wf` / `ee` / `dd` / `w` 四格 int 并且可能改 `rgt` 与 `mxsl` ——
 * 挑中定点时 `ee` 是 0（照 `EncodeReal0` 的口径：`e` 非零才用 `%e`）、`dd` 是小数位数。
 * 标量那一档 `mxl` 与 `mnl` 都是它自己的 `left`。
 */
function fmtPickStmts(v) {
  const nm = (name) => ({ kind: 'name', name });
  const I = (value) => ({ kind: 'int', value });
  const set = (name, value) => ({ kind: 'assign', target: nm(name), value });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const [neg, mxl, mnl, mxsl, rgt, mxns] = [v.neg, v.mxl, v.mnl, v.mxsl, v.rgt, v.mxns].map(nm);
  return [
    /* 全在 0 与 1 之间时左边只有那一位 `0`（`%#w.dg` 的前导零） */
    iff(b('<', mxl, I(0)), [set(v.mxsl, b('+', I(1), neg))]),
    iff(b('<', rgt, I(0)), [set(v.rgt, I(0))]),
    { kind: 'let', name: v.wf, type: INT, init: b('+', mxsl, rgt) },
    iff(b('!=', rgt, I(0)), [set(v.wf, b('+', nm(v.wf), I(1)))]),
    /* 科学记数那一支：符号 + 首位 + 点 + nsig-1 位 + `e+XX`（指数三位时多一格） */
    { kind: 'let', name: v.ee, type: INT, init: I(1) },
    iff(b('||', b('>', mxl, I(100)), b('<=', mnl, I(-99))), [set(v.ee, I(2))]),
    { kind: 'let', name: v.dd, type: INT, init: b('-', mxns, I(1)) },
    {
      kind: 'let',
      name: v.w,
      type: INT,
      init: b('+', b('+', b('+', neg, nm(v.dd)), I(4)), nm(v.ee)),
    },
    iff(b('>', nm(v.dd), I(0)), [set(v.w, b('+', nm(v.w), I(1)))]),
    /* `scipen` 是 0，平手偏定点 —— 这正是 `wF <= *w + R_print.scipen` 那一句 */
    iff(b('<=', nm(v.wf), nm(v.w)),
      [set(v.ee, I(0)), set(v.dd, rgt), set(v.w, nm(v.wf))]),
  ];
}

/**
 * R 的"定点还是科学记数"那条挑法 —— **照 `src/main/format.c` 抄**，不是 `%.7g`。
 *
 * 从前这儿是 `(sgen x 7)`，也就是 C 的 `%.7g`。那一格是**按指数**挑的（`-4 <= X < P`
 * 才用定点），而 R 是**按哪个短**挑的（`formatReal` 里那句 `if (wF <= *w + scipen)`）。
 * 两条规矩在 `1e5` 上就分道：`%g` 印 `100000`（六位，指数 5 < 7 所以走定点），
 * R 印 `1e+05` —— 它算出定点要 6 格、科学记数要 5 格，于是挑短的那个。
 *
 * 两步分别在 `sciFnDecl()`（那格数的三个数）与 `fmtPickStmts()`（挑与算宽）。
 * 排版本身不自己写：`(sfix x n)` / `(ssci x n)` 就是 C 的 `%.nf` / `%.ne`
 * （两条腿上都是按位算的十进制，就近取偶、指数至少两位），正是 `EncodeReal0` 用的那两格。
 */
function numFmtStmts() {
  const nm = (name) => ({ kind: 'name', name });
  const I = (value) => ({ kind: 'int', value });
  const x = nm('x');
  const slot = (i) => call1('toint', { kind: 'deref', expr: call1('padd', nm('p'), I(i)) });
  const V = {
    neg: 'neg', mxl: 'left', mnl: 'left', mxsl: 'sleft', rgt: 'rgt', mxns: 'nsig',
    wf: 'wf', ee: 'ee', dd: 'dd', w: 'w',
  };
  return [
    { kind: 'let', name: 'p', type: PTR_REAL, init: call1('pnew', tyArg(PTR_REAL), I(3)) },
    { kind: 'expr-stmt', expr: lglCall('r_sci', x, nm('d'), nm('p')) },
    { kind: 'let', name: 'neg', type: INT, init: slot(0) },
    { kind: 'let', name: 'left', type: INT, init: slot(1) },
    { kind: 'let', name: 'nsig', type: INT, init: slot(2) },
    /* 一格数的极值就是它自己：`mxl = mnl = left`、`mxns = nsig` */
    { kind: 'let', name: 'sleft', type: INT, init: b('+', nm('neg'), I(1)) },
    {
      kind: 'if',
      cond: b('>', nm('left'), I(0)),
      then: [{ kind: 'assign', target: nm('sleft'), value: b('+', nm('neg'), nm('left')) }],
      else_: null,
    },
    { kind: 'let', name: 'rgt', type: INT, init: b('-', nm('nsig'), nm('left')) },
    ...fmtPickStmts(V),
    {
      kind: 'if',
      cond: b('==', nm('ee'), I(0)),
      then: [{ kind: 'return', values: [call1('sfix', x, nm('dd'))] }],
      else_: null,
    },
    { kind: 'return', values: [call1('ssci', x, nm('dd'))] },
  ];
}

/**
 * `print()` 与**顶层自动印**那一族生成出来的函数。
 *
 * R 印一条向量不是"每格各自印"：它先把整条向量的宽度取极值、**挑一次**定点还是科学记数
 * （`formatReal`），然后每格按同一套 `(w, d, e)` 右对齐排版，行首带 `[k]` 标号、
 * 到 80 列换行（`printVector` / `printRealVector`）。所以：
 *
 *   print(c(1.5, 22.25, 333))   [1]   1.50  22.25 333.00     ← 共用 6 格宽、2 位小数
 *   print(c(0.001, 1000))       [1] 1e-03 1e+03              ← 定点要 8 格、科学记数 5 格
 *   print(1:25)                  [1]  1  2  3 … 25           ← 标号宽按最后一格算（`[25]`）
 *
 * 标号那一格也是对齐的：宽度按**最后一个标号**算，所以 25 格的向量行首是 ` [1]`（前面一格空）。
 */
function printFnDecl(name) {
  const nm = (n) => ({ kind: 'name', name: n });
  const I = (v) => ({ kind: 'int', value: v });
  const R = (v) => ({ kind: 'real', value: v });
  const S = (v) => ({ kind: 'string', value: v });
  const rm = (f, ...a) => call1('rmath', { kind: 'strlit', value: f }, ...a);
  const letI = (n, init) => ({ kind: 'let', name: n, type: INT, init });
  const letS = (n, init) => ({ kind: 'let', name: n, type: STR, init });
  const letBo = (n, init) => ({ kind: 'let', name: n, type: BOOL, init });
  const set = (n, v) => ({ kind: 'assign', target: nm(n), value: v });
  const iff = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
  const wr = (s) => ({ kind: 'builtin-stmt', name: 'write', args: [s] });
  const isNa = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [e] });
  const isNan = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_is_nan') }, args: [e] });
  const x = nm('x');
  const v = nm('v');
  const i = nm('i');
  const j = nm('j');
  const ret = (e) => ({ kind: 'return', values: [e] });

  if (name === 'r_num_fmt') {
    /* 一格元素按定好的 `(d, e)` 排版。三处非有限值照 `EncodeReal0`：`NA` / `NaN` / `±Inf`。
       **负零要先归一**：IEEE 有 `-0.0`，而 C 的 `%.*f` 把它印成 `-0`。R 在 `EncodeReal0`
       里有一句 `if(x == 0.) x = 0.;`（`-0.0 == 0.0` 为真，于是换成正零），所以 R 印 `0`。
       量出来的：`print(c(-0.0))` R 答 `0`，不归一就答 `-0`。`sprintf("%.1f", -0.0)` 那一格
       R **不**归一（它直接走 C 的 sprintf，两边都是 `-0.0`），所以那条路不动。 */
    cabiUsed.add('omni_r_is_infinite');
    rmathSig('omni_r_is_infinite');
    const inf = b('!=', { kind: 'ccall', sym: 'omni_r_is_infinite', args: [x] }, I(0));
    return {
      kind: 'fn',
      name,
      params: [{ name: 'x', type: REAL }, { name: 'd', type: INT }, { name: 'e', type: INT }],
      ret: STR,
      body: [
        iff(isNa(x), [iff(isNan(x), [ret(S('NaN'))]), ret(S('NA'))]),
        iff(inf, [iff(b('>', x, R(0)), [ret(S('Inf'))]), ret(S('-Inf'))]),
        iff(b('==', x, R(0)), [set('x', R(0))]),
        iff(b('==', nm('e'), I(0)), [ret(call1('sfix', x, nm('d')))]),
        ret(call1('ssci', x, nm('d'))),
      ],
    };
  }

  /* 标号 + 换行那一圈（两个印法共用）。`elem` 给"第 j 格的文本"。 */
  const pad = (s, w) => ({
    kind: 'ternary',
    cond: b('<', call1('slen', s), w),
    then: call1('srep', S(' '), b('-', w, call1('slen', s))),
    else_: S(''),
  });
  const wrapStmts = (elem) => [
    letS('lab', b('+', b('+', S('['), call1('tostr', nm('n'))), S(']'))),
    letI('lw', call1('slen', nm('lab'))),
    /* 一行几格：`(80 - 标号宽) / (每格宽 + 1)`。**按实数算再取整** —— 方言里两格 int
       相除是不是整除这一层不打包票，而这儿要的就是向下取整。 */
    letI('per', call1('toint', rm('floor', b('/',
      call1('toreal', b('-', I(80), nm('lw'))), call1('toreal', b('+', nm('w'), I(1))))))),
    iff(b('<', nm('per'), I(1)), [set('per', I(1))]),
    letI('i', I(0)),
    {
      kind: 'while',
      cond: b('<', i, nm('n')),
      body: [
        letS('l2', b('+', b('+', S('['), call1('tostr', b('+', i, I(1)))), S(']'))),
        wr(pad(nm('l2'), nm('lw'))),
        wr(nm('l2')),
        letI('j', i),
        {
          kind: 'while',
          cond: b('&&', b('<', j, nm('n')), b('<', j, b('+', i, nm('per')))),
          body: [
            letS('s', elem(j)),
            wr(S(' ')),
            wr(pad(nm('s'), nm('w'))),
            wr(nm('s')),
            set('j', b('+', j, I(1))),
          ],
        },
        wr(S('\n')),
        set('i', b('+', i, nm('per'))),
      ],
    },
  ];

  if (name === 'r_print_lgl') {
    /* `formatLogical`：宽从 1 起，见过 `NA` 至少 2、见过 `TRUE` 至少 4、见过 `FALSE` 就是 5。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }],
      ret: { kind: 'void' },
      body: [
        letI('n', vecLen(v)),
        /* 零长向量 R 印的是类型名（`logical(0)`）—— 那一格走不到下面的标号那一圈。 */
        iff(b('==', nm('n'), I(0)), [wr(S('logical(0)\n')), { kind: 'return', values: [] }]),
        letI('w', I(1)),
        {
          kind: 'for',
          init: letI('i', I(0)),
          cond: b('<', i, nm('n')),
          post: set('i', b('+', i, I(1))),
          body: [
            iff(isNa(vecGet(v, i)),
              [iff(b('<', nm('w'), I(2)), [set('w', I(2))])],
              [iff(b('!=', vecGet(v, i), R(0)),
                [iff(b('<', nm('w'), I(4)), [set('w', I(4))])],
                [iff(b('<', nm('w'), I(5)), [set('w', I(5))])])]),
          ],
        },
        ...wrapStmts((k) => lglCall('r_lgl_str', vecGet(v, k))),
      ],
    };
  }

  /* 数值向量：先把每格的 `(neg, left, nsig)` 取极值（`r_sci`），再挑一次、算出共用的宽。
     这一段（到那四条 `NA` / `Inf` 撑宽为止）**两个印法共用** —— `r_print_named` 的值那一行
     与 `r_print_num` 是同一套宽度，差别只在外头的版式。 */
  const BIG = 1000000000;
  const inf1 = (e) => b('!=', { kind: 'ccall', sym: 'omni_r_is_infinite', args: [e] }, I(0));
  cabiUsed.add('omni_r_is_infinite');
  rmathSig('omni_r_is_infinite');
  const el = vecGet(v, i);
  const agg = [
    { kind: 'let', name: 'p', type: PTR_REAL, init: call1('pnew', tyArg(PTR_REAL), I(3)) },
    letI('neg', I(0)),
    letI('mxl', I(-BIG)),
    letI('mnl', I(BIG)),
    letI('mxsl', I(-BIG)),
    letI('rgt', I(-BIG)),
    letI('mxns', I(-BIG)),
    letI('fin', I(0)),
    letBo('hasna', { kind: 'bool', value: false }),
    letBo('hasnan', { kind: 'bool', value: false }),
    letBo('haspi', { kind: 'bool', value: false }),
    letBo('hasni', { kind: 'bool', value: false }),
    {
      kind: 'for',
      init: letI('i', I(0)),
      cond: b('<', i, nm('n')),
      post: set('i', b('+', i, I(1))),
      body: [
        iff(isNa(el),
          [iff(isNan(el),
            [set('hasnan', { kind: 'bool', value: true })],
            [set('hasna', { kind: 'bool', value: true })])],
          [iff(inf1(el),
            [iff(b('>', el, R(0)),
              [set('haspi', { kind: 'bool', value: true })],
              [set('hasni', { kind: 'bool', value: true })])],
            [
              set('fin', b('+', nm('fin'), I(1))),
              { kind: 'expr-stmt', expr: lglCall('r_sci', el, I(7), nm('p')) },
              letI('ng', call1('toint', { kind: 'deref', expr: call1('padd', nm('p'), I(0)) })),
              letI('lf', call1('toint', { kind: 'deref', expr: call1('padd', nm('p'), I(1)) })),
              letI('ns', call1('toint', { kind: 'deref', expr: call1('padd', nm('p'), I(2)) })),
              letI('sl', b('+', nm('ng'), I(1))),
              iff(b('>', nm('lf'), I(0)), [set('sl', b('+', nm('ng'), nm('lf')))]),
              letI('rt', b('-', nm('ns'), nm('lf'))),
              iff(b('>', nm('rt'), nm('rgt')), [set('rgt', nm('rt'))]),
              iff(b('>', nm('lf'), nm('mxl')), [set('mxl', nm('lf'))]),
              iff(b('<', nm('lf'), nm('mnl')), [set('mnl', nm('lf'))]),
              iff(b('>', nm('sl'), nm('mxsl')), [set('mxsl', nm('sl'))]),
              iff(b('>', nm('ns'), nm('mxns')), [set('mxns', nm('ns'))]),
              iff(b('!=', nm('ng'), I(0)), [set('neg', I(1))]),
            ])]),
      ],
    },
    ...fmtPickStmts({
      neg: 'neg', mxl: 'mxl', mnl: 'mnl', mxsl: 'mxsl', rgt: 'rgt', mxns: 'mxns',
      wf: 'wf', ee: 'ee', dd: 'dd', w: 'w',
    }),
    /* 一格有限值都没有时那几个极值还是哨兵，按 `formatReal` 的口径清零（`w` 由下面那四条撑） */
    iff(b('==', nm('fin'), I(0)), [set('w', I(0)), set('dd', I(0)), set('ee', I(0))]),
    /* `NA` 占 2 格、`NaN` 与 `Inf` 占 3、`-Inf` 占 4（`R_print.na_width` 是 2） */
    iff(b('&&', nm('hasna'), b('<', nm('w'), I(2))), [set('w', I(2))]),
    iff(b('&&', nm('hasnan'), b('<', nm('w'), I(3))), [set('w', I(3))]),
    iff(b('&&', nm('haspi'), b('<', nm('w'), I(3))), [set('w', I(3))]),
    iff(b('&&', nm('hasni'), b('<', nm('w'), I(4))), [set('w', I(4))]),
  ];

  if (name === 'r_print_named') {
    /* **带名字的向量**：名字一行、值一行，两行**共用一个宽** `cw = max(值的宽, 最长的名字)`，
       每格右对齐到 `cw` 再跟一个空格（所以每行**末尾有一个空格** —— 量出来的，`Rscript`，
       2026-09-25）。一行几格是 `floor(80 / (cw + 1))`：这一档没有 `[1]` 那个标号。
       名字那一条空着（长度对不上）就退回 `r_print_num` —— R 里名字被丢掉之后印的就是它。 */
    const ns = nm('ns');
    const row = (elem, wid) => ({
      kind: 'while',
      cond: b('&&', b('<', j, nm('n')), b('<', j, b('+', i, nm('per')))),
      body: [
        letS('s', elem(j)),
        wr(pad(nm('s'), wid)),
        wr(nm('s')),
        wr(S(' ')),
        set('j', b('+', j, I(1))),
      ],
    });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'ns', type: RSTRV }, { name: 'z', type: STR }],
      ret: { kind: 'void' },
      body: [
        letI('n', vecLen(v)),
        iff(b('==', nm('n'), I(0)), [
          wr(b('+', b('+', S('named '), nm('z')), S('\n'))),
          { kind: 'return', values: [] },
        ]),
        iff(b('<', call1('alen', ns), nm('n')), [
          { kind: 'expr-stmt', expr: lglCall('r_print_num', v, nm('z')) },
          { kind: 'return', values: [] },
        ]),
        ...agg,
        letI('cw', nm('w')),
        {
          kind: 'for',
          init: letI('k', I(0)),
          cond: b('<', nm('k'), nm('n')),
          post: set('k', b('+', nm('k'), I(1))),
          body: [
            letI('sl2', call1('slen', svGet(ns, nm('k')))),
            iff(b('>', nm('sl2'), nm('cw')), [set('cw', nm('sl2'))]),
          ],
        },
        letI('per', call1('toint', rm('floor', b('/',
          call1('toreal', I(80)), call1('toreal', b('+', nm('cw'), I(1))))))),
        iff(b('<', nm('per'), I(1)), [set('per', I(1))]),
        letI('i', I(0)),
        {
          kind: 'while',
          cond: b('<', i, nm('n')),
          body: [
            letI('j', i),
            row((k) => svGet(ns, k), nm('cw')),
            wr(S('\n')),
            set('j', i),
            row((k) => lglCall('r_num_fmt', vecGet(v, k), nm('dd'), nm('ee')), nm('cw')),
            wr(S('\n')),
            set('i', b('+', i, nm('per'))),
          ],
        },
      ],
    };
  }

  return {
    kind: 'fn',
    name,
    params: [{ name: 'v', type: RVEC }, { name: 'z', type: STR }],
    ret: { kind: 'void' },
    body: [
      letI('n', vecLen(v)),
      /* 零长向量印**元素类型名**（`diff(c(1))` 是 `numeric(0)`、`which(…)` 是
         `integer(0)`）—— 那一行字由调用点给（见 `RIVEC` 与 `zeroName`）。 */
      iff(b('==', nm('n'), I(0)), [
        wr(b('+', nm('z'), S('\n'))),
        { kind: 'return', values: [] },
      ]),
      ...agg,
      ...wrapStmts((k) => lglCall('r_num_fmt', vecGet(v, k), nm('dd'), nm('ee'))),
    ],
  };
}

/**
 * 那三格**按指针**走的辅助函数（`r_na` / `r_is_na` / `r_is_nan`），用到了才发。
 *
 * 形状都一样：开一格 `(ptr real)` 的一元缓冲，把值写进去（或者让 C 写进去），
 * 再按位读回来。理由在 `PTR_REAL` 那段账上 —— `NA` 的载荷按值过 N-API 会丢。
 */
function naFnDecl(name) {
  const sym = NA_FNS.get(name);
  cabiUsed.add(sym);
  rmathSig(sym);
  const p = { kind: 'name', name: 'p' };
  const alloc = {
    kind: 'let', name: 'p', type: PTR_REAL,
    init: { kind: 'builtin', name: 'pnew', args: [tyArg(PTR_REAL), { kind: 'int', value: 1 }] },
  };
  if (name === 'r_na') {
    return {
      kind: 'fn', name, params: [], ret: REAL,
      body: [
        alloc,
        { kind: 'expr-stmt', expr: { kind: 'ccall', sym, args: [p] } },
        { kind: 'return', values: [{ kind: 'deref', expr: p }] },
      ],
    };
  }
  return {
    kind: 'fn',
    name,
    params: [{ name: 'x', type: REAL }],
    ret: BOOL,
    body: [
      alloc,
      /* 写进线性内存 —— 这一步之后那格值就不再经过装箱了 */
      { kind: 'assign', target: { kind: 'deref', expr: p }, value: { kind: 'name', name: 'x' } },
      {
        kind: 'return',
        values: [b('!=', { kind: 'ccall', sym, args: [p] }, { kind: 'int', value: 0 })],
      },
    ],
  };
}

/**
 * 三态逻辑那一族**生成出来的**辅助函数（`RLGL1` 那段账说了为什么是函数）。
 *
 * 存法：`1.0` 是 TRUE、`0.0` 是 FALSE、`NA` 是缺失。三态表照 R 的文档
 * （`&` / `|` 那两格的真值表在 `?Logic` 里）：
 *
 *   `a & b`  —— 有一边是 FALSE 就 FALSE（**哪怕另一边是 NA**），否则有 NA 就 NA，否则 TRUE
 *   `a | b`  —— 有一边是 TRUE 就 TRUE（**哪怕另一边是 NA**），否则有 NA 就 NA，否则 FALSE
 *   `!a`     —— NA 取反还是 NA
 *
 * `NA & FALSE` 是 FALSE 这一格是要紧的：按"有 NA 就 NA"写会答错。
 */
function lglFnDecl(name) {
  const x = { kind: 'name', name: 'x' };
  const y = { kind: 'name', name: 'y' };
  const na = () => lglCall('r_na');
  const isNa = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [e] });
  const T = { kind: 'real', value: 1 };
  const F = { kind: 'real', value: 0 };
  const isF = (e) => b('==', e, F);
  const ret = (v) => ({ kind: 'return', values: [v] });
  const fn2 = (body) => ({
    kind: 'fn', name, params: [{ name: 'x', type: REAL }, { name: 'y', type: REAL }], ret: REAL, body,
  });
  const fn1 = (retTy, body) => ({
    kind: 'fn', name, params: [{ name: 'x', type: REAL }], ret: retTy, body,
  });

  if (name === 'r_lgl') {
    /* R 的 `as.logical`：`NA` 与 `NaN` 都是 `NA`（`is.na` 对两格都真，一问就够）。 */
    return fn1(REAL, [
      { kind: 'if', cond: isNa(x), then: [ret(na())], else_: null },
      ret({ kind: 'ternary', cond: b('!=', x, F), then: T, else_: F }),
    ]);
  }
  if (name === 'r_and') {
    return fn2([
      { kind: 'if', cond: b('||', isF(x), isF(y)), then: [ret(F)], else_: null },
      { kind: 'if', cond: b('||', isNa(x), isNa(y)), then: [ret(na())], else_: null },
      ret(T),
    ]);
  }
  if (name === 'r_or') {
    /* "是 TRUE"要连着问一句"不是 NA" —— `NA != 0` 在浮点上是**真**（NA 是个 NaN），
       所以只写 `x != 0` 会把 `NA | FALSE` 答成 TRUE。反过来"是 FALSE"（`x == 0`）
       对 NaN 自然为假，那一格不用多问。 */
    const isT = (e) => b('&&', { kind: 'unop', op: '!', operand: isNa(e) }, b('!=', e, F));
    return fn2([
      { kind: 'if', cond: b('||', isT(x), isT(y)), then: [ret(T)], else_: null },
      { kind: 'if', cond: b('||', isNa(x), isNa(y)), then: [ret(na())], else_: null },
      ret(F),
    ]);
  }
  if (name === 'r_not') {
    return fn1(REAL, [
      { kind: 'if', cond: isNa(x), then: [ret(na())], else_: null },
      ret({ kind: 'ternary', cond: isF(x), then: T, else_: F }),
    ]);
  }
  if (name === 'r_xor') {
    /* `xor(a, b)` 就是 `(a | b) & !(a & b)`：两边都不缺失时看"是不是一真一假"。 */
    return fn2([
      { kind: 'if', cond: b('||', isNa(x), isNa(y)), then: [ret(na())], else_: null },
      ret({
        kind: 'ternary',
        cond: b('!=', b('!=', x, F), b('!=', y, F)),
        then: T,
        else_: F,
      }),
    ]);
  }
  if (name === 'r_is_true' || name === 'r_is_false') {
    /* `isTRUE` / `isFALSE` 回的是**两态**（R 的文档：`isTRUE(NA)` 是 `FALSE`，不是 `NA`）。 */
    const want = name === 'r_is_true' ? b('!=', x, F) : b('==', x, F);
    return fn1(BOOL, [
      { kind: 'if', cond: isNa(x), then: [ret({ kind: 'bool', value: false })], else_: null },
      ret(want),
    ]);
  }
  if (name === 'r_ifelse1') {
    /* 一格的 `ifelse`：判断缺失就交缺失（R 的 `ifelse(NA, 1, 2)` 是 `NA`）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'x', type: REAL }, { name: 'y', type: REAL }, { name: 'z', type: REAL }],
      ret: REAL,
      body: [
        { kind: 'if', cond: isNa(x), then: [ret(na())], else_: null },
        ret({ kind: 'ternary', cond: b('!=', x, F), then: y, else_: { kind: 'name', name: 'z' } }),
      ],
    };
  }
  if (name === 'r_cond') {
    /* `if (NA)` 在 R 里是一条**错误**，不是"当假"。`(fail …)` 是方言里停下来的那一格。 */
    return fn1(BOOL, [
      {
        kind: 'if',
        cond: isNa(x),
        then: [{
          /* `(fail …)` 在方言里**只当语句**，包进 `(expr …)` 那侧会报"不认识的表达式" */
          kind: 'builtin-stmt',
          name: 'fail',
          args: [{ kind: 'string', value: 'missing value where TRUE/FALSE needed' }],
        }],
        else_: null,
      },
      ret(b('!=', x, F)),
    ]);
  }
  if (name === 'r_lgl_str') {
    return fn1(STR, [
      { kind: 'if', cond: isNa(x), then: [ret({ kind: 'string', value: 'NA' })], else_: null },
      ret({
        kind: 'ternary',
        cond: b('!=', x, F),
        then: { kind: 'string', value: 'TRUE' },
        else_: { kind: 'string', value: 'FALSE' },
      }),
    ]);
  }
  /* 比较那六格：两边任一是 NA（含 NaN）就 NA，否则按方言的比较折成 1 / 0。 */
  const op = [...CMP_FNS.entries()].find(([, v]) => v === name);
  if (op === undefined) throw new Error(`r->IR: 不认识的逻辑辅助函数 ${name}`);
  return fn2([
    { kind: 'if', cond: b('||', isNa(x), isNa(y)), then: [ret(na())], else_: null },
    ret({ kind: 'ternary', cond: b(op[0], x, y), then: T, else_: F }),
  ]);
}

/**
 * 向量那几格**生成出来的**辅助函数（用到才发）。
 *
 * 为什么是生成的函数而不是在调用点摊开：`sum` / `cat` 这几格都要一个 `while`，摊在调用点上
 * `.sx` 就读不动了（而 `.sx` 是这条路上唯一人能读、能 diff、能进快照的中间产物）。
 * 这与 `ext/go/go-rt.js` 给 go 发运行时是同一条路。
 */
function vecFnDecl(name) {
  const v = { kind: 'name', name: 'v' };
  const i = { kind: 'name', name: 'i' };
  const acc = { kind: 'name', name: 's' };
  /* **长度先存进一格 int**，循环条件读它 —— 不然每转一圈都要 `(toint (pload v))`，
     那是一次内存读 + 一次转换。量出来的（bench/r/run.js，2026-09-25）：
     `vec.R` 上光这一条就是 2.0s → 0.66s。 */
  const len = { kind: 'name', name: 'n' };
  const declLen = (from) => ({ kind: 'let', name: 'n', type: INT, init: vecLen(from ?? v) });
  const elem = vecGet(v, i);
  const loop = (body, from) => ({
    kind: 'for',
    init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: from } },
    cond: b('<', i, len),
    post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
    body,
  });
  const P = [{ name: 'v', type: RVEC }];

  if (name === 'r_as_int_v') {
    /* `as.integer(向量)` —— 逐元素**朝零截**（R 的口径：`as.integer(-2.7)` 是 `-2`）。
       缺失原样留着：这一档的"整数向量"底下还是 double（见 `RIVEC`），所以 `NA` 跟得住，
       印出来与 R 一样。 */
    const out = { kind: 'name', name: 'o' };
    const isNa = { kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [elem] };
    const rm = (f) => call1('rmath', { kind: 'strlit', value: f }, elem);
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RIVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        loop([{
          kind: 'if',
          cond: isNa,
          then: [vecSet(out, i, elem)],
          else_: [vecSet(out, i, {
            kind: 'ternary',
            cond: b('<', elem, { kind: 'real', value: 0 }),
            then: rm('ceil'),
            else_: rm('floor'),
          })],
        }], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_sum') {    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        declLen(),
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 0 } },
        loop([{ kind: 'assign', target: acc, value: b('+', acc, elem) }], 0),
        { kind: 'return', values: [acc] },
      ],
    };
  }
  if (name === 'r_mean') {
    /**
     * **R 的 `mean` 是两遍的**（`src/main/summary.c` 的实数那一支）：先 `sum/n`，再拿
     * 那个均值扫第二遍把残差加回去 ——
     *
     * ```c
     * s /= n;
     * if (R_FINITE((double) s)) { t = 0; for(i) t += (x[i] - s); s += t / n; }
     * ```
     *
     * 只写 `sum/n` 与 R 差最后一两位。量出来的（2026-09-26）：
     * `cor(sin(1:50), cos(1:50))` 一遍版是 `-0.0042002210293471563`、
     * R 是 `-0.0042002210293471485`（7 位有效数字那一档看不出来，`%.17g` 一比就分家）。
     * `cov` / `cor` / `var` / `sd` 都从这一格取均值，所以这一处补上，那四格跟着对。
     *
     * 第二遍前的 `R_FINITE` 那道闸门照抄：零长时 `0/0` 是 `NaN`（R 的
     * `mean(numeric(0))` 也是 `NaN`），那一趟不做修正 —— 不然 `NaN - NaN` 白转一圈。
     */
    cabiUsed.add('omni_r_is_infinite');
    rmathSig('omni_r_is_infinite');
    const m = { kind: 'name', name: 'm' };
    const t2 = { kind: 'name', name: 't' };
    const fin = b('&&', { kind: 'unop', op: '!', operand: naQ(m) },
      b('==', { kind: 'ccall', sym: 'omni_r_is_infinite', args: [m] }, { kind: 'int', value: 0 }));
    const nr = call1('toreal', len);
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        declLen(),
        {
          kind: 'let',
          name: 'm',
          type: REAL,
          init: b('/', { kind: 'call', fn: { kind: 'name', name: 'r_sum' }, args: [v] }, nr),
        },
        {
          kind: 'if',
          cond: fin,
          then: [
            { kind: 'let', name: 't', type: REAL, init: { kind: 'real', value: 0 } },
            {
              kind: 'for',
              init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
              cond: b('<', i, len),
              post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
              body: [{ kind: 'assign', target: t2, value: b('+', t2, b('-', elem, m)) }],
            },
            { kind: 'assign', target: m, value: b('+', m, b('/', t2, nr)) },
          ],
          else_: null,
        },
        { kind: 'return', values: [m] },
      ],
    };
  }
  if (name === 'r_max' || name === 'r_min') {
    const op = name === 'r_max' ? '>' : '<';
    cabiUsed.add('omni_r_nan');
    rmathSig('omni_r_nan');
    const nanQ = { kind: 'call', fn: { kind: 'name', name: useFn('r_is_nan') }, args: [elem] };
    const T = { kind: 'bool', value: true };
    return {
      kind: 'fn', name, params: P, ret: REAL,
      /* 空向量在 R 里回 `-Inf` / `Inf` 并且**发一句警告**；这一版没有警告那条通道，
         所以空向量这一格当场报（在 `r_sum` 之外唯一与 R 不同的地方，明写在 SPEC）。
         **缺失要传下去**：R 的 `max(c(1, NA))` 是 `NA`，而按 `>` 比是躲不过去的
         （`NaN > x` 恒假，于是 NA 会被"跳过"、答成 1）—— 所以每格先问一句。
         **`NA` 与 `NaN` 要分开记**：R 的口径是"有 `NA` 就是 `NA`、只有 `NaN` 才是 `NaN`"
         （`max(c(1, NaN))` 是 `NaN`、`max(c(NaN, NA))` 是 `NA` —— 量出来的，与次序无关）。
         从前这儿见着缺失就当场回 `NA`，于是 `max(1, NaN)` 答 `NA` 而 R 答 `NaN`。 */
      body: [
        declLen(),
        { kind: 'let', name: 's', type: REAL, init: vecGet(v, { kind: 'int', value: 0 }) },
        { kind: 'let', name: 'sna', type: BOOL, init: { kind: 'bool', value: false } },
        { kind: 'let', name: 'snan', type: BOOL, init: { kind: 'bool', value: false } },
        loop([{
          kind: 'if',
          cond: naQ(elem),
          then: [{
            kind: 'if',
            cond: nanQ,
            then: [{ kind: 'assign', target: { kind: 'name', name: 'snan' }, value: T }],
            else_: [{ kind: 'assign', target: { kind: 'name', name: 'sna' }, value: T }],
          }],
          else_: [{
            kind: 'if',
            cond: b(op, elem, acc),
            then: [{ kind: 'assign', target: acc, value: elem }],
            else_: null,
          }],
        }], 0),
        {
          kind: 'if',
          cond: { kind: 'name', name: 'sna' },
          then: [{ kind: 'return', values: [{ kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }] }],
          else_: null,
        },
        {
          kind: 'if',
          cond: { kind: 'name', name: 'snan' },
          then: [{ kind: 'return', values: [{ kind: 'ccall', sym: 'omni_r_nan', args: [] }] }],
          else_: null,
        },
        { kind: 'return', values: [acc] },
      ],
    };
  }
  if (name === 'r_cat_vec') {
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'sep', type: STR }],
      ret: { kind: 'void' },
      body: [declLen(), loop([
        {
          kind: 'if',
          cond: b('>', i, { kind: 'int', value: 0 }),
          then: [{ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'name', name: 'sep' }] }],
          else_: null,
        },
        {
          kind: 'builtin-stmt',
          name: 'write',
          args: [{
            kind: 'call',
            fn: { kind: 'name', name: NUM_STR },
            args: [elem, { kind: 'int', value: 7 }],
          }],
        },
      ], 0)],
    };
  }
  if (name === 'r_rev') {
    /* `rev(xs)` —— 倒着抄一遍。 */
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        loop([vecSet(out, i, vecGet(v, b('-', b('-', len, i), { kind: 'int', value: 1 })))], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_seq_along') {
    /* `seq_along(xs)` 是 `1:length(xs)`（但 `length` 为 0 时 R 回零长向量 —— 见 SPEC）。 */
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        loop([vecSet(out, i, asReal(b('+', i, { kind: 'int', value: 1 }), INT))], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_which') {
    /* `which(m)` —— 为真的那几格的**位置**（从 1 起）。R 里 `NA` 不算（直接丢），
       与 `xs[m]` 不同 —— 那边 `NA` 会挑出一格 `NA`。两趟：先数几格，再填。 */
    const out = { kind: 'name', name: 'o' };
    const k = { kind: 'name', name: 'k' };
    const c = { kind: 'name', name: 'c' };
    const hit = b('&&', { kind: 'unop', op: '!', operand: naQ(vecGet(v, i)) }, b('!=', vecGet(v, i), { kind: 'real', value: 0 }));
    const loopA = (body, init) => ({
      kind: 'for', init, cond: b('<', i, len), post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) }, body,
    });
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
        { kind: 'let', name: 'c', type: INT, init: { kind: 'int', value: 0 } },
        loopA([{ kind: 'if', cond: hit, then: [{ kind: 'assign', target: c, value: b('+', c, { kind: 'int', value: 1 }) }], else_: null }],
          { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        ...vecNewAs('o', c),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'int', value: 0 } },
        loopA([{
          kind: 'if',
          cond: hit,
          then: [
            vecSet(out, k, asReal(b('+', i, { kind: 'int', value: 1 }), INT)),
            { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
          ],
          else_: null,
        }], { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_vec_pick') {
    /**
     * `xs[下标向量]` —— R 在这一格上有**三条**规矩（量出来的，`Rscript`，2026-09-25）：
     *
     *   * 全是正数：按位置挑（1 起），而**下标 0 直接跳过**（`x[c(1,0,2)]` 是两格）；
     *   * 全是负数：把那几格**丢掉**（`x[-1]` / `x[-c(1,3)]`），越界的负下标**不算**
     *     （`x[-5]` 在长度 4 上就是原样）；
     *   * 正负**混着**：R 报错 —— 这儿也当场停下来（`(fail …)`）。
     *
     * 判"正还是负"是**运行期**的事（`x[c(-1,-2)]` 与 `x[-c(1,3)]` 在树上不同形），
     * 所以这三条都在这一个函数里，不在调用点上。`NA` 下标 R 挑出一格 `NA`，
     * 数值这一侧我们本来有 `NA`，但"挑出来的长度"会跟着变 —— 那一格停下来，不猜。
     */
    const ix = { kind: 'name', name: 'ix' };
    const m = { kind: 'name', name: 'm' };
    const n = { kind: 'name', name: 'n' };
    const j = { kind: 'name', name: 'j' };
    const k = { kind: 'name', name: 'k' };
    const I0 = (val) => ({ kind: 'int', value: val });
    const letI2 = (nm2, init) => ({ kind: 'let', name: nm2, type: INT, init });
    const setI = (nm2, val) => ({ kind: 'assign', target: { kind: 'name', name: nm2 }, value: val });
    const forJ = (upto, body) => ({
      kind: 'for',
      init: letI2('j', I0(0)),
      cond: b('<', j, upto),
      post: setI('j', b('+', j, I0(1))),
      body,
    });
    const forI = (upto, body) => ({
      kind: 'for',
      init: letI2('i', I0(0)),
      cond: b('<', i, upto),
      post: setI('i', b('+', i, I0(1))),
      body,
    });
    const at = vecGet(ix, j);
    const iff2 = (cond, then, else_ = null) => ({ kind: 'if', cond, then, else_ });
    const keep = { kind: 'name', name: 'kp' };
    const out = { kind: 'name', name: 'o' };
    const out2 = { kind: 'name', name: 'o2' };
    const pos = { kind: 'name', name: 'p' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'ix', type: RVEC }],
      ret: RVEC,
      body: [
        letI2('m', vecLen(ix)),
        letI2('n', vecLen(v)),
        letI2('nneg', I0(0)),
        letI2('npos', I0(0)),
        forJ(m, [
          iff2({ kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [at] }, [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{ kind: 'string', value: 'NA in a numeric subscript: 挑出来的长度说不清' }],
          }]),
          iff2(b('<', at, { kind: 'real', value: 0 }),
            [setI('nneg', b('+', { kind: 'name', name: 'nneg' }, I0(1)))],
            [iff2(b('>', at, { kind: 'real', value: 0 }),
              [setI('npos', b('+', { kind: 'name', name: 'npos' }, I0(1)))])]),
        ]),
        iff2(b('&&', b('>', { kind: 'name', name: 'nneg' }, I0(0)), b('>', { kind: 'name', name: 'npos' }, I0(0))), [{
          kind: 'builtin-stmt',
          name: 'fail',
          args: [{ kind: 'string', value: "can't mix positive and negative subscripts" }],
        }]),
        /* 全是负数 → 丢掉那几格（先标一遍留不留，再抄）。 */
        iff2(b('>', { kind: 'name', name: 'nneg' }, I0(0)), [
          ...vecNewAs('kp', n),
          forI(n, [vecSet(keep, i, { kind: 'real', value: 1 })]),
          forJ(m, [
            letI2('p', b('-', I0(0), call1('toint', at))),
            iff2(b('&&', b('>=', pos, I0(1)), b('<=', pos, n)),
              [vecSet(keep, b('-', pos, I0(1)), { kind: 'real', value: 0 })]),
          ]),
          letI2('k', I0(0)),
          forI(n, [iff2(b('!=', vecGet(keep, i), { kind: 'real', value: 0 }), [setI('k', b('+', k, I0(1)))])]),
          ...vecNewAs('o2', k),
          setI('k', I0(0)),
          forI(n, [iff2(b('!=', vecGet(keep, i), { kind: 'real', value: 0 }), [
            vecSet(out2, k, vecGet(v, i)),
            setI('k', b('+', k, I0(1))),
          ])]),
          { kind: 'return', values: [out2] },
        ]),
        /* 全是正数（或者一格都没有）→ 按位置挑，下标 0 跳过。 */
        letI2('kk', I0(0)),
        forJ(m, [iff2(b('!=', at, { kind: 'real', value: 0 }), [setI('kk', b('+', { kind: 'name', name: 'kk' }, I0(1)))])]),
        ...vecNewAs('o', { kind: 'name', name: 'kk' }),
        letI2('w', I0(0)),
        forJ(m, [iff2(b('!=', at, { kind: 'real', value: 0 }), [
          vecSet(out, { kind: 'name', name: 'w' }, vecGet(v, b('-', call1('toint', at), I0(1)))),
          setI('w', b('+', { kind: 'name', name: 'w' }, I0(1))),
        ])]),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_vec_mask') {
    /* `xs[xs > 2]` —— 按逻辑向量挑。掩码短了**从头再来**（R 的回收规则在这儿也管），
       掩码里的 `NA` 在 R 里挑出**一格 NA**（不是"跳过"），所以数与填都把它算上。
       两趟：先数出结果有几格（长度要在 `pnew` 之前知道），再填。 */
    const m = { kind: 'name', name: 'm' };
    const out = { kind: 'name', name: 'o' };
    const k = { kind: 'name', name: 'k' };
    const c = { kind: 'name', name: 'c' };
    const mi = vecGet(m, b('%', i, { kind: 'name', name: 'nm' }));
    const loopV = (body, init) => ({
      kind: 'for',
      init,
      cond: b('<', i, len),
      post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
      body,
    });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'm', type: RVEC }],
      ret: RVEC,
      body: [
        /* 两个长度都先存进 int（循环条件与回收那一格各要读一次）。 */
        declLen(),
        { kind: 'let', name: 'nm', type: INT, init: vecLen(m) },
        /* `i` 在函数体上先声明一次 —— 两趟都用它，摆在 `for` 的 init 里的话第二趟就看不见了。 */
        { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
        { kind: 'let', name: 'c', type: INT, init: { kind: 'int', value: 0 } },
        loopV([{
          kind: 'if',
          cond: b('||', naQ(mi), b('!=', mi, { kind: 'real', value: 0 })),
          then: [{ kind: 'assign', target: c, value: b('+', c, { kind: 'int', value: 1 }) }],
          else_: null,
        }], { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        ...vecNewAs('o', c),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'int', value: 0 } },
        loopV([{
          kind: 'if',
          cond: naQ(mi),
          then: [
            vecSet(out, k, { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }),
            { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
          ],
          else_: [{
            kind: 'if',
            cond: b('!=', mi, { kind: 'real', value: 0 }),
            then: [
              vecSet(out, k, vecGet(v, i)),
              { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
            ],
            else_: null,
          }],
        }], { kind: 'assign', target: i, value: { kind: 'int', value: 0 } }),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_cat_lgl') {
    /* 逻辑向量的印法：`TRUE` / `FALSE` / `NA` 三档（存的是 1.0 / 0.0 / NA）。 */
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'sep', type: STR }],
      ret: { kind: 'void' },
      body: [declLen(), loop([
        {
          kind: 'if',
          cond: b('>', i, { kind: 'int', value: 0 }),
          then: [{ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'name', name: 'sep' }] }],
          else_: null,
        },
        {
          kind: 'if',
          cond: naQ(elem),
          then: [{ kind: 'builtin-stmt', name: 'write', args: [{ kind: 'string', value: 'NA' }] }],
          else_: [{
            kind: 'builtin-stmt',
            name: 'write',
            args: [{
              kind: 'ternary',
              cond: b('!=', elem, { kind: 'real', value: 0 }),
              then: { kind: 'string', value: 'TRUE' },
              else_: { kind: 'string', value: 'FALSE' },
            }],
          }],
        },
      ], 0)],
    };
  }
  if (name === 'r_any' || name === 'r_all') {
    /* `any` / `all` —— R 的口径是"先看有没有决定性的那一格"：
       `any` 见到一个 TRUE 就交 TRUE（后面还有 NA 也不管），一个都没见到但见过 NA 就 NA；
       `all` 对称。所以一趟走完、记一格"见过 NA 没有"就够，不用两趟。 */
    const isAny = name === 'r_any';
    const seen = { kind: 'name', name: 'q' };
    const F = { kind: 'real', value: 0 };
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        declLen(),
        { kind: 'let', name: 'q', type: BOOL, init: { kind: 'bool', value: false } },
        loop([{
          kind: 'if',
          cond: naQ(elem),
          then: [{ kind: 'assign', target: seen, value: { kind: 'bool', value: true } }],
          else_: [{
            kind: 'if',
            cond: isAny ? b('!=', elem, F) : b('==', elem, F),
            then: [{ kind: 'return', values: [{ kind: 'real', value: isAny ? 1 : 0 }] }],
            else_: null,
          }],
        }], 0),
        {
          kind: 'if',
          cond: seen,
          then: [{ kind: 'return', values: [{ kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }] }],
          else_: null,
        },
        { kind: 'return', values: [{ kind: 'real', value: isAny ? 0 : 1 }] },
      ],
    };
  }
  /* ── base 里那一族"向量进向量出"的（`sort` / `cumsum` / `diff` / …）───────
     缺失那一格各有各的口径，照 R 的文档办：`sort` **把 NA 丢掉**（`na.last = NA`），
     `cumsum` / `prod` / `var` / `sd` 按浮点自然传播，`range` 有一格 NA 就整个 `NA NA`。 */
  if (name === 'r_drop_na') {
    /* `na.rm = TRUE` 那一格：先抄出一条"没有缺失的"，再照常算。
       为什么是"先滤再算"而不是给每个聚合函数加一个开关：`sum` / `mean` / `max` / `min` /
       `prod` / `var` / `sd` / `range` / `any` / `all` 在 R 里 `na.rm` 的意思**就是**
       "把 NA 当不存在"，滤一遍与逐个函数里跳过同解（`mean` 的分母也跟着变小）。
       一处写法、九个函数都对，而且不用改那几个函数的签名。 */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    const keep = { kind: 'unop', op: '!', operand: naQ(elem) };   /* `r_is_na` 回的是 bool */
    return {
      kind: 'fn',
      name,
      params: P,
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'int', value: 0 } },
        loop([{
          kind: 'if', cond: keep, then: [{ kind: 'assign', target: kk, value: b('+', kk, { kind: 'int', value: 1 }) }], else_: null,
        }], 0),
        ...vecNewAs('o', kk),
        { kind: 'assign', target: kk, value: { kind: 'int', value: 0 } },
        loop([{
          kind: 'if',
          cond: keep,
          then: [
            vecSet(out, kk, elem),
            { kind: 'assign', target: kk, value: b('+', kk, { kind: 'int', value: 1 }) },
          ],
          else_: null,
        }], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_sort') {
    /* Shell 排序（Knuth 的 gap 序列 1, 4, 13, 40…）。R 自己用的是快排/基数排序
       （`src/main/sort.c`，那半边在解释器里、不在 nmath），而"全排序"的结果是唯一的
       —— double 上相等的元素分不出来，所以哪种算法都逐字节一致。
       为什么不是插入排序：那一格是 O(n²)，`sort(1:10000)` 会当场趴下。 */
    const out = { kind: 'name', name: 'o' };
    const c = { kind: 'name', name: 'c' };
    const k = { kind: 'name', name: 'k' };
    const g = { kind: 'name', name: 'g' };
    const j = { kind: 'name', name: 'j' };
    const t = { kind: 'name', name: 't' };
    const oAt = (e) => vecGet(out, e);
    return {
      kind: 'fn', name, params: P, ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'c', type: INT, init: { kind: 'int', value: 0 } },
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, len),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [{
            kind: 'if',
            cond: { kind: 'unop', op: '!', operand: naQ(elem) },
            then: [{ kind: 'assign', target: c, value: b('+', c, { kind: 'int', value: 1 }) }],
            else_: null,
          }],
        },
        ...vecNewAs('o', c),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'int', value: 0 } },
        {
          kind: 'for',
          init: { kind: 'let', name: 'i2', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', { kind: 'name', name: 'i2' }, len),
          post: {
            kind: 'assign',
            target: { kind: 'name', name: 'i2' },
            value: b('+', { kind: 'name', name: 'i2' }, { kind: 'int', value: 1 }),
          },
          body: [{
            kind: 'if',
            cond: { kind: 'unop', op: '!', operand: naQ(vecGet(v, { kind: 'name', name: 'i2' })) },
            then: [
              vecSet(out, k, vecGet(v, { kind: 'name', name: 'i2' })),
              { kind: 'assign', target: k, value: b('+', k, { kind: 'int', value: 1 }) },
            ],
            else_: null,
          }],
        },
        /* gap 先涨到最大的那一格（`g*3 < c` 而不是 `g < c/3` —— 不碰整除这一问） */
        { kind: 'let', name: 'g', type: INT, init: { kind: 'int', value: 1 } },
        {
          kind: 'while',
          cond: b('<', b('*', g, { kind: 'int', value: 3 }), c),
          body: [{ kind: 'assign', target: g, value: b('+', b('*', g, { kind: 'int', value: 3 }), { kind: 'int', value: 1 }) }],
        },
        {
          kind: 'while',
          cond: b('>=', g, { kind: 'int', value: 1 }),
          body: [
            {
              kind: 'for',
              init: { kind: 'let', name: 'i3', type: INT, init: g },
              cond: b('<', { kind: 'name', name: 'i3' }, c),
              post: {
                kind: 'assign',
                target: { kind: 'name', name: 'i3' },
                value: b('+', { kind: 'name', name: 'i3' }, { kind: 'int', value: 1 }),
              },
              body: [
                { kind: 'let', name: 't', type: REAL, init: oAt({ kind: 'name', name: 'i3' }) },
                { kind: 'let', name: 'j', type: INT, init: { kind: 'name', name: 'i3' } },
                {
                  kind: 'while',
                  cond: b('&&', b('>=', j, g), b('>', oAt(b('-', j, g)), t)),
                  body: [
                    vecSet(out, j, oAt(b('-', j, g))),
                    { kind: 'assign', target: j, value: b('-', j, g) },
                  ],
                },
                vecSet(out, j, t),
              ],
            },
            /* 1, 4, 13, 40… 倒着走就是 `(g-1)/3`（这个序列上是整的，按实数算再取整） */
            {
              kind: 'assign',
              target: g,
              value: call1('toint', call1('rmath', { kind: 'strlit', value: 'floor' },
                b('/', call1('toreal', b('-', g, { kind: 'int', value: 1 })), { kind: 'real', value: 3 }))),
            },
          ],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_cummax' || name === 'r_cummin') {
    /**
     * `cummax` / `cummin`：**碰上缺失之后全是缺失**（R：`cummax(c(1,NA,3))` 是 `1 NA NA`）。
     *
     * 为什么不能只写 `if (elem > acc) acc = elem`：与 `NaN` 比出来的都是假，于是那一格
     * 会被当成"没它大"直接跳过 —— 印出来是 `1 1 3`，而 R 是 `1 NA NA`。
     * 所以要一格 `bad` 记住"见过缺失了没有"，见过之后一路写 `NA`。
     */
    const out = { kind: 'name', name: 'o' };
    const bad = { kind: 'name', name: 'bad' };
    const isNa = { kind: 'call', fn: { kind: 'name', name: useFn('r_is_na') }, args: [elem] };
    const na = { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] };
    const better = name === 'r_cummax' ? b('>', elem, acc) : b('<', elem, acc);
    return {
      kind: 'fn', name, params: P, ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        { kind: 'let', name: 'bad', type: BOOL, init: { kind: 'bool', value: false } },
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 0 } },
        loop([
          { kind: 'if', cond: isNa, then: [{ kind: 'assign', target: bad, value: { kind: 'bool', value: true } }], else_: null },
          {
            kind: 'if',
            cond: bad,
            then: [vecSet(out, i, na)],
            else_: [
              /* 第一格直接收下（`acc` 的初值 0 不该参与比较）。 */
              {
                kind: 'if',
                cond: b('||', b('==', i, { kind: 'int', value: 0 }), better),
                then: [{ kind: 'assign', target: acc, value: elem }],
                else_: null,
              },
              vecSet(out, i, acc),
            ],
          },
        ], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_rep_len') {
    /** `rep_len(x, n)`：**循环取**到长度 `n`（短了从头再来、长了截掉）。 */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'k', type: INT }],
      ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', kk),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, kk),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          /* `%` 在两个 int 上是 C 的取余，而这儿两边都非负 —— 与 R 的循环取一致。 */
          body: [vecSet(out, i, vecGet(v, b('%', i, len)))],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_tab_n') {
    /**
     * `tabulate(bin)` 不给 `nbins` 时的**那个默认长度**。R 的默认实参写的是
     * `nbins = max(1, bin, na.rm = TRUE)`，而 `.Internal` 收的是 `as.integer(nbins)`
     * —— 所以 `tabulate(c(2.7, 2.2, 1.9))` 的长度是 **2**（不是 3），印出来是 `1 2`。
     *
     * 为什么单独一格函数、不摊在调用点上：`max(1, v)` 要把那条向量读一遍，而调用点上
     * 摆不下临时量（`tabulate(f(x))` 里 `f(x)` 只该求值一次）。
     */
    return {
      kind: 'fn', name, params: P, ret: INT,
      body: [
        declLen(),
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 1 } },
        loop([{
          kind: 'if',
          cond: b('&&', { kind: 'unop', op: '!', operand: naQ(elem) }, b('>', elem, acc)),
          then: [{ kind: 'assign', target: acc, value: elem }],
          else_: null,
        }], 0),
        /* `s >= 1`（初值就是 1），所以 `floor` 与 R 的 `as.integer` 朝零截同解。 */
        { kind: 'return', values: [call1('toint', call1('rmath', { kind: 'strlit', value: 'floor' }, acc))] },
      ],
    };
  }
  if (name === 'r_tabulate') {
    /**
     * `tabulate(bin, nbins)`：数**每一格 1..nbins 出现了几次**。
     *
     * 三种格子都不记（R 的口径，量出来的）：缺失、`<= 0`、`> nbins`。值先朝零截
     * （`tabulate(c(2.7))` 记进第 2 格）。回的是**整数向量** —— 零长时印 `integer(0)`。
     */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    const j = { kind: 'name', name: 'j' };
    const t = { kind: 'name', name: 't' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'k', type: INT }],
      ret: RIVEC,
      body: [
        declLen(),
        ...vecNewAs('o', kk),
        /* `pnew` 开出来的内存**不保证是零**（`r_ext` 那段账也记着这件事），所以先清一遍。 */
        {
          kind: 'for',
          init: { kind: 'let', name: 'j', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', j, kk),
          post: { kind: 'assign', target: j, value: b('+', j, { kind: 'int', value: 1 }) },
          body: [vecSet(out, j, { kind: 'real', value: 0 })],
        },
        loop([{
          kind: 'if',
          cond: { kind: 'unop', op: '!', operand: naQ(elem) },
          then: [
            { kind: 'let', name: 't', type: INT, init: call1('toint', call1('rmath', { kind: 'strlit', value: 'floor' }, elem)) },
            {
              kind: 'if',
              cond: b('&&', b('>=', t, { kind: 'int', value: 1 }), b('<=', t, kk)),
              then: [vecSet(out, b('-', t, { kind: 'int', value: 1 }),
                b('+', vecGet(out, b('-', t, { kind: 'int', value: 1 })), { kind: 'real', value: 1 }))],
              else_: null,
            },
          ],
          else_: null,
        }], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_tab_a') {
    /** `tabulate(bin)`（不给 `nbins`）：默认长度由 `r_tab_n` 量出来。 */
    return {
      kind: 'fn', name, params: P, ret: RIVEC,
      body: [{
        kind: 'return',
        values: [{
          kind: 'call',
          fn: { kind: 'name', name: 'r_tabulate' },
          args: [v, { kind: 'call', fn: { kind: 'name', name: 'r_tab_n' }, args: [v] }],
        }],
      }],
    };
  }
  if (name === 'r_any_na') {
    /**
     * `anyNA(x)`：这条向量里有没有缺失。**`NaN` 也算**（R 的 `is.na(NaN)` 是 TRUE，
     * 量出来 `anyNA(c(1, NaN))` 是 TRUE）—— 而 `r_is_na` 底下就是 `isnan`，正是这个口径。
     *
     * 不在循环里直接 `return`：一格 bool 攒着，读完再回 —— 少一条从循环体里跳出去的边。
     */
    const f = { kind: 'name', name: 'f' };
    return {
      kind: 'fn', name, params: P, ret: BOOL,
      body: [
        declLen(),
        { kind: 'let', name: 'f', type: BOOL, init: { kind: 'bool', value: false } },
        loop([{
          kind: 'if',
          cond: naQ(elem),
          then: [{ kind: 'assign', target: f, value: { kind: 'bool', value: true } }],
          else_: null,
        }], 0),
        { kind: 'return', values: [f] },
      ],
    };
  }
  if (name === 'r_median') {
    /**
     * `median(x)`：排完取中间 —— 奇数格取正中那一格，偶数格取中间**两格的平均**
     * （R：`median(c(1,2,3,4))` 是 `2.5`）。
     *
     * 缺失那一问要**在排之前**问：`r_sort` 顺手把缺失丢了，排完就看不出原来有没有缺失，
     * 而 R 在 `na.rm = FALSE`（默认）时答的是 `NA`。`na.rm = TRUE` 那一档在调用点上
     * 先过一道 `r_drop_na`（`dropNa`），所以这儿见不到缺失。
     * 零长也回 `NA`（R：`median(numeric(0))` 是 `NA`）。
     */
    const s = { kind: 'name', name: 'q' };
    const ln = { kind: 'name', name: 'm' };
    const half = b('/', ln, { kind: 'int', value: 2 });
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        {
          kind: 'if',
          cond: { kind: 'call', fn: { kind: 'name', name: useFn('r_any_na') }, args: [v] },
          then: [{ kind: 'return', values: [{ kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }] }],
          else_: null,
        },
        { kind: 'let', name: 'q', type: RVEC, init: { kind: 'call', fn: { kind: 'name', name: useFn('r_sort') }, args: [v] } },
        { kind: 'let', name: 'm', type: INT, init: vecLen(s) },
        {
          kind: 'if',
          cond: b('==', ln, { kind: 'int', value: 0 }),
          then: [{ kind: 'return', values: [{ kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] }] }],
          else_: null,
        },
        {
          kind: 'if',
          cond: b('==', b('%', ln, { kind: 'int', value: 2 }), { kind: 'int', value: 1 }),
          then: [{ kind: 'return', values: [vecGet(s, half)] }],
          else_: null,
        },
        {
          kind: 'return',
          values: [b('/', b('+', vecGet(s, b('-', half, { kind: 'int', value: 1 })), vecGet(s, half)),
            { kind: 'real', value: 2 })],
        },
      ],
    };
  }
  if (name === 'r_cumsum') {
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn', name, params: P, ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 0 } },
        loop([
          { kind: 'assign', target: acc, value: b('+', acc, elem) },
          vecSet(out, i, acc),
        ], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_prod') {
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        declLen(),
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 1 } },
        loop([{ kind: 'assign', target: acc, value: b('*', acc, elem) }], 0),
        { kind: 'return', values: [acc] },
      ],
    };
  }
  if (name === 'r_range') {
    /* 有一格缺失就整个 `NA NA`（R 的 `range(c(1, NA))`）—— 与 `max` / `min` 同一条。 */
    const out = { kind: 'name', name: 'o' };
    const mn = { kind: 'name', name: 'mn' };
    const mx = { kind: 'name', name: 'mx' };
    const na = () => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] });
    return {
      kind: 'fn', name, params: P, ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'mn', type: REAL, init: vecGet(v, { kind: 'int', value: 0 }) },
        { kind: 'let', name: 'mx', type: REAL, init: vecGet(v, { kind: 'int', value: 0 }) },
        { kind: 'let', name: 'bad', type: BOOL, init: { kind: 'bool', value: false } },
        loop([{
          kind: 'if',
          cond: naQ(elem),
          then: [{ kind: 'assign', target: { kind: 'name', name: 'bad' }, value: { kind: 'bool', value: true } }],
          else_: [
            { kind: 'if', cond: b('<', elem, mn), then: [{ kind: 'assign', target: mn, value: elem }], else_: null },
            { kind: 'if', cond: b('>', elem, mx), then: [{ kind: 'assign', target: mx, value: elem }], else_: null },
          ],
        }], 0),
        ...vecNewAs('o', { kind: 'int', value: 2 }),
        {
          kind: 'if',
          cond: { kind: 'name', name: 'bad' },
          then: [
            vecSet(out, { kind: 'int', value: 0 }, na()),
            vecSet(out, { kind: 'int', value: 1 }, na()),
          ],
          else_: [
            vecSet(out, { kind: 'int', value: 0 }, mn),
            vecSet(out, { kind: 'int', value: 1 }, mx),
          ],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_diff') {
    /**
     * `diff(v, k)`：相隔 `k` 格相减。长度是 `max(0, n - k)` —— 不够长就出零长
     * （R 那边印 `numeric(0)`，量出来 `diff(c(1,4), lag = 5)` 就是它）。
     */
    const out = { kind: 'name', name: 'o' };
    const m = { kind: 'name', name: 'm' };
    const kk = { kind: 'name', name: 'k' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'k', type: INT }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'm', type: INT, init: b('-', len, kk) },
        { kind: 'if', cond: b('<', m, { kind: 'int', value: 0 }), then: [{ kind: 'assign', target: m, value: { kind: 'int', value: 0 } }], else_: null },
        ...vecNewAs('o', m),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, m),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, b('-', vecGet(v, b('+', i, kk)), vecGet(v, i)))],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_bit_v') {
    /**
     * 位运算那一族的**32 位闸门**。R 的整数是 32 位的，这一档的 `int` 是 64 位 ——
     * 于是"出了 32 位"这件事在 R 那边有值（`NA_integer_`）而在这儿没有。
     *
     * 量出来的两格：`bitwShiftL(1L, 31L)` R 印 `NA`（算出来正好是 `INT_MIN`，而
     * `NA_INTEGER` **就是** `INT_MIN` —— 不是"溢出了报错"，是那个位型被占用了）、
     * `bitwNot(2147483647L)` 同理。所以合法区间是 `[-2147483647, 2147483647]`，
     * 出去了**当场报**，不给一个 R 不会给的数（那是静默答错）。
     */
    const xx = { kind: 'name', name: 'x' };
    const lim = { kind: 'int', value: 2147483647 };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'x', type: INT }],
      ret: INT,
      body: [
        {
          kind: 'if',
          cond: b('||', b('>', xx, lim), b('<', xx, b('-', { kind: 'int', value: 0 }, lim))),
          then: [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{
              kind: 'string',
              value: 'bitw*(): 出了 32 位 —— R 那边这一格是 NA_integer_（NA_INTEGER 就是 INT_MIN），'
                + '而这一档还没有"带缺失的整数"（见 ext/r/SPEC.md 第四节第 11 条）',
            }],
          }],
          else_: null,
        },
        { kind: 'return', values: [xx] },
      ],
    };
  }
  if (name === 'r_bit_and' || name === 'r_bit_or' || name === 'r_bit_xor') {
    /** `bitwAnd` / `bitwOr` / `bitwXor`：两边都在 32 位里，结果也就在 32 位里。 */
    const op = { r_bit_and: '&', r_bit_or: '|', r_bit_xor: '^' }[name];
    const gate = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_bit_v') }, args: [e] });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: INT }, { name: 'c', type: INT }],
      ret: INT,
      body: [{
        kind: 'return',
        values: [gate(b(op, gate({ kind: 'name', name: 'a' }), gate({ kind: 'name', name: 'c' })))],
      }],
    };
  }
  if (name === 'r_bit_not') {
    /** `bitwNot(x)` 就是 `x ^ -1`（方言的一元算符只有 `-` 与 `!` —— 没有 `~`）。 */
    const gate = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_bit_v') }, args: [e] });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: INT }],
      ret: INT,
      body: [{
        kind: 'return',
        values: [gate(b('^', gate({ kind: 'name', name: 'a' }), { kind: 'int', value: -1 }))],
      }],
    };
  }
  if (name === 'r_bit_shl' || name === 'r_bit_shr') {
    /**
     * `bitwShiftL` / `bitwShiftR`：**移的是那 32 个位**，而这一档的 `int` 有 64 个 ——
     * 所以两边都要自己摆：先 `& 0xFFFFFFFF` 取出那 32 位，移完再把第 31 位铺回符号
     * （左移那一格），右移是**补零的**（量出来 `bitwShiftR(-1L, 1L)` 是 `2147483647`，
     * 不是 `-1` —— 所以不能用方言的 `>>`，那是算术移位）。
     *
     * 位数不在 `0..31` 里时 R 回 `NA`，这儿当场报（同 `r_bit_v` 那段账）。
     */
    const a = { kind: 'name', name: 'a' };
    const nn = { kind: 'name', name: 'n' };
    const u = { kind: 'name', name: 'u' };
    const M32 = { kind: 'int', value: 4294967295 };
    const gate = (e) => ({ kind: 'call', fn: { kind: 'name', name: useFn('r_bit_v') }, args: [e] });
    const shl = name === 'r_bit_shl';
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: INT }, { name: 'n', type: INT }],
      ret: INT,
      body: [
        { kind: 'expr-stmt', expr: gate(a) },
        {
          kind: 'if',
          cond: b('||', b('<', nn, { kind: 'int', value: 0 }), b('>', nn, { kind: 'int', value: 31 })),
          then: [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{ kind: 'string', value: 'bitwShift*(): 位数不在 0..31 里 —— R 那边这一格是 NA_integer_，这一档没有那种值' }],
          }],
          else_: null,
        },
        /* 那 32 个位（`a` 是负数时这一步把符号位铺开的那些 1 收进 32 位里）。 */
        {
          kind: 'let',
          name: 'u',
          type: INT,
          init: shl
            ? b('&', b('<<', b('&', a, M32), nn), M32)
            : b('>>', b('&', a, M32), nn),
        },
        /* 左移完第 31 位是 1 的话，那是个负数 —— 把上头 32 位补成 1（符号扩展）。
           右移是补零的，结果一定非负，不必补。 */
        ...(shl ? [{
          kind: 'if',
          cond: b('>=', u, { kind: 'int', value: 2147483648 }),
          then: [{ kind: 'assign', target: u, value: b('-', u, { kind: 'int', value: 4294967296 }) }],
          else_: null,
        }] : []),
        { kind: 'return', values: [gate(u)] },
      ],
    };
  }
  if (name === 'r_rank') {
    /**
     * `rank(x)`：并列那几格取**平均**（R 的默认 `ties.method = "average"`，
     * 量出来 `rank(c(2,2,1))` 是 `2.5 2.5 1.0`）。
     *
     * 办法是对每一格数两遍："有几格比它小"与"有几格与它同"，名次就是
     * `nless + (neq + 1) / 2`。这是 O(n²) —— 换成"排完再扫"能到 O(n log n)，但那要
     * 多一条下标向量，而这一格的用处是几十格的向量，先要对。
     *
     * 缺失**留在结果里**、排在最后（R 的默认 `na.last = TRUE`）：第 k 个缺失拿
     * `非缺失格数 + k`（量出来 `rank(c(NA,1,NA))` 是 `2 1 3`）。`NaN` 与 `NA` 同档
     * （`r_is_na` 底下是 `isnan`）—— R 也是这么办的。
     */
    const out = { kind: 'name', name: 'o' };
    const cnt = { kind: 'name', name: 'c' };
    const seen = { kind: 'name', name: 'g' };
    const i1 = { kind: 'name', name: 'i1' };
    const i2 = { kind: 'name', name: 'i2' };
    const j = { kind: 'name', name: 'j' };
    const less = { kind: 'name', name: 'nl' };
    const eq = { kind: 'name', name: 'ne' };
    const forN = (nmS, body) => ({
      kind: 'for',
      init: { kind: 'let', name: nmS, type: INT, init: { kind: 'int', value: 0 } },
      cond: b('<', { kind: 'name', name: nmS }, len),
      post: { kind: 'assign', target: { kind: 'name', name: nmS }, value: b('+', { kind: 'name', name: nmS }, { kind: 'int', value: 1 }) },
      body,
    });
    const at = (e) => vecGet(v, e);
    const bump = (t) => ({ kind: 'assign', target: t, value: b('+', t, { kind: 'int', value: 1 }) });
    return {
      kind: 'fn', name, params: P, ret: RVEC,
      body: [
        declLen(),
        ...vecNewAs('o', len),
        { kind: 'let', name: 'c', type: INT, init: { kind: 'int', value: 0 } },
        forN('i1', [{ kind: 'if', cond: { kind: 'unop', op: '!', operand: naQ(at(i1)) }, then: [bump(cnt)], else_: null }]),
        { kind: 'let', name: 'g', type: INT, init: { kind: 'int', value: 0 } },
        forN('i2', [{
          kind: 'if',
          cond: naQ(at(i2)),
          then: [bump(seen), vecSet(out, i2, call1('toreal', b('+', cnt, seen)))],
          else_: [
            { kind: 'let', name: 'nl', type: INT, init: { kind: 'int', value: 0 } },
            { kind: 'let', name: 'ne', type: INT, init: { kind: 'int', value: 0 } },
            forN('j', [{
              kind: 'if',
              cond: { kind: 'unop', op: '!', operand: naQ(at(j)) },
              then: [{
                kind: 'if',
                cond: b('<', at(j), at(i2)),
                then: [bump(less)],
                else_: [{
                  kind: 'if',
                  cond: { kind: 'call', fn: { kind: 'name', name: useFn('r_same') }, args: [at(j), at(i2)] },
                  then: [bump(eq)],
                  else_: null,
                }],
              }],
              else_: null,
            }]),
            vecSet(out, i2, b('+', call1('toreal', less),
              b('/', call1('toreal', b('+', eq, { kind: 'int', value: 1 })), { kind: 'real', value: 2 }))),
          ],
        }]),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_append' || name === 'r_append_e') {
    /**
     * `append(x, values, after)`：把 `values` **插在第 `after` 格之后**。
     * `after = 0` 是插到最前面、`after = length(x)` 是接到最后（那也是不写时的默认）。
     *
     * 为什么"接到最后"是**另一格函数**而不是拿 `after = -1` 当暗号：R 那边负的 `after`
     * 是报错（量出来 `append(c(1,2,3), 9, after = -1)` 报"只有负下标里才能有零"），
     * 拿它当暗号就是把一格 R 会拒的输入悄悄当成了默认 —— 那是静默答错。
     */
    const a = { kind: 'name', name: 'a' };
    const bb = { kind: 'name', name: 'b' };
    const at = { kind: 'name', name: 'at' };
    const out = { kind: 'name', name: 'o' };
    const na = { kind: 'name', name: 'na' };
    const nb = { kind: 'name', name: 'nb' };
    if (name === 'r_append_e') {
      return {
        kind: 'fn',
        name,
        params: [{ name: 'a', type: RVEC }, { name: 'b', type: RVEC }],
        ret: RVEC,
        body: [{
          kind: 'return',
          values: [{ kind: 'call', fn: { kind: 'name', name: 'r_append' }, args: [a, bb, vecLen(a)] }],
        }],
      };
    }
    const i1 = { kind: 'name', name: 'i1' };
    const i2 = { kind: 'name', name: 'i2' };
    const i3 = { kind: 'name', name: 'i3' };
    const forN = (nm, from, cnt, body) => ({
      kind: 'for',
      init: { kind: 'let', name: nm, type: INT, init: from },
      cond: b('<', { kind: 'name', name: nm }, cnt),
      post: { kind: 'assign', target: { kind: 'name', name: nm }, value: b('+', { kind: 'name', name: nm }, { kind: 'int', value: 1 }) },
      body,
    });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: RVEC }, { name: 'b', type: RVEC }, { name: 'at', type: INT }],
      ret: RVEC,
      body: [
        { kind: 'let', name: 'na', type: INT, init: vecLen(a) },
        { kind: 'let', name: 'nb', type: INT, init: vecLen(bb) },
        ...vecNewAs('o', b('+', na, nb)),
        /* 前一段、插进来的那一段、后一段 —— 三趟抄。 */
        forN('i1', { kind: 'int', value: 0 }, at, [vecSet(out, i1, vecGet(a, i1))]),
        forN('i2', { kind: 'int', value: 0 }, nb, [vecSet(out, b('+', at, i2), vecGet(bb, i2))]),
        forN('i3', at, na, [vecSet(out, b('+', i3, nb), vecGet(a, i3))]),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_ext') {
    /**
     * `x[k] <- v` 里 `k` 超出长度时把向量**接长到 k 格**，空档填 `NA`（R 的口径）。
     *
     * 回的是"该用哪一格向量"：够长就原样回 `v`（**一个字节都不拷**，这条路最常走），
     * 不够才开一格新的、把老的抄过去、空档写 `NA`。调用方拿回值重新绑到那个变量上 ——
     * R 的赋值本来就是值语义（写一格会整份复制），所以换一格指针不会让别人看见。
     *
     * 为什么空档要显式写 `NA`：`vecNewAs` 开出来的内存**不保证是零**（`r_zeros`
     * 那一格的注释也记着这件事），而且 R 那边空档是 `NA` 而不是 0 —— 少这一趟就是
     * `x <- c(1,2); x[5] <- 9; print(x)` 印出一串垃圾。
     */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'k', type: INT }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'if', cond: b('<=', kk, len), then: [{ kind: 'return', values: [v] }], else_: null },
        ...vecNewAs('o', kk),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, kk),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [{
            kind: 'if',
            cond: b('<', i, len),
            then: [vecSet(out, i, vecGet(v, i))],
            else_: [vecSet(out, i, { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] })],
          }],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_replace') {
    /**
     * `replace(x, k, v)` 在 R 里就是 `x[k] <- v` 的函数写法 —— 所以这一格与那一格
     * **同一套口径**：
     *
     *   * `v` 比 `k` 短就**循环取**（量出来 `replace(c(1,2,3,4), c(2,3), 0)` 是 `1 0 0 4`）
     *   * `k` 超出长度就**接长**，空档填 `NA`（`replace(c(1,2), 5, 9)` 是 `1 2 NA NA 9`）
     *     —— 借的正是 `x[k] <- v` 那一格的 `r_ext`
     *   * `k` 是 0 的那一格**什么都不写**（R 那边 `x[0] <- 9` 是个空动作）
     *
     * 下标是负数那一档（R 里是"除了这几格"）**没接** —— 当场报而不是当成正的写进去。
     */
    const ix = { kind: 'name', name: 'ix' };
    const val = { kind: 'name', name: 'val' };
    const out = { kind: 'name', name: 'o' };
    const m = { kind: 'name', name: 'm' };
    const nv = { kind: 'name', name: 'nv' };
    const j = { kind: 'name', name: 'j' };
    const kk = { kind: 'name', name: 'k' };
    const at = vecGet(ix, j);
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'ix', type: RVEC }, { name: 'val', type: RVEC }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'm', type: INT, init: vecLen(ix) },
        { kind: 'let', name: 'nv', type: INT, init: vecLen(val) },
        /* 先抄一份 —— `replace` 不改进来的那条（R 的赋值是值语义）。 */
        ...vecNewAs('o', len),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, len),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, vecGet(v, i))],
        },
        {
          kind: 'for',
          init: { kind: 'let', name: 'j', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', j, m),
          post: { kind: 'assign', target: j, value: b('+', j, { kind: 'int', value: 1 }) },
          body: [
            {
              kind: 'if',
              cond: naQ(at),
              then: [{
                kind: 'builtin-stmt',
                name: 'fail',
                args: [{ kind: 'string', value: 'replace(): 下标里有 NA —— 写到哪一格说不清' }],
              }],
              else_: null,
            },
            { kind: 'let', name: 'k', type: INT, init: call1('toint', at) },
            {
              kind: 'if',
              cond: b('<', kk, { kind: 'int', value: 0 }),
              then: [{
                kind: 'builtin-stmt',
                name: 'fail',
                args: [{ kind: 'string', value: 'replace(): 负下标还没接（R 那边它是"除了这几格"）' }],
              }],
              else_: null,
            },
            {
              kind: 'if',
              cond: b('>=', kk, { kind: 'int', value: 1 }),
              then: [
                { kind: 'assign', target: out, value: { kind: 'call', fn: { kind: 'name', name: useFn('r_ext') }, args: [out, kk] } },
                vecSet(out, b('-', kk, { kind: 'int', value: 1 }), vecGet(val, b('%', j, nv))),
              ],
              else_: null,
            },
          ],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_ext_nm') {
    /**
     * 名字那一条跟着长：接到 `k` 格，新格是**空串**（R 的口径 ——
     * `x <- c(a=1); x[3] <- 5; names(x)` 是 `"a" "" ""`）。
     *
     * 名字住在 `(arr string)` 里（可增长），所以这儿是 `apush` 而不是重新开一格。
     * 名字是**空的**（长度 0 —— 那个向量本来没名字）就什么都不做：R 那边也不会
     * 因为一次下标写就给整份向量凭空造出一串空名字。
     */
    const ns = { kind: 'name', name: 'ns' };
    const kk = { kind: 'name', name: 'k' };
    const nn = { kind: 'name', name: 'n' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'ns', type: RSTRV }, { name: 'k', type: INT }],
      ret: RSTRV,
      body: [
        { kind: 'let', name: 'n', type: INT, init: call1('alen', ns) },
        { kind: 'if', cond: b('==', nn, { kind: 'int', value: 0 }), then: [{ kind: 'return', values: [ns] }], else_: null },
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: nn },
          cond: b('<', i, kk),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [{ kind: 'builtin-stmt', name: 'apush', args: [ns, { kind: 'string', value: '' }] }],
        },
        { kind: 'return', values: [ns] },
      ],
    };
  }
  if (name === 'r_head' || name === 'r_tail') {
    /* `head(v, k)` / `tail(v, k)`：`k` 是负数时 R 的意思是"去掉那么多格"。 */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    const off = { kind: 'name', name: 'off' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'k0', type: INT }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'k', type: INT, init: { kind: 'name', name: 'k0' } },
        { kind: 'if', cond: b('<', kk, { kind: 'int', value: 0 }), then: [{ kind: 'assign', target: kk, value: b('+', len, kk) }], else_: null },
        { kind: 'if', cond: b('<', kk, { kind: 'int', value: 0 }), then: [{ kind: 'assign', target: kk, value: { kind: 'int', value: 0 } }], else_: null },
        { kind: 'if', cond: b('>', kk, len), then: [{ kind: 'assign', target: kk, value: len }], else_: null },
        ...vecNewAs('o', kk),
        {
          kind: 'let',
          name: 'off',
          type: INT,
          init: name === 'r_head' ? { kind: 'int', value: 0 } : b('-', len, kk),
        },
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, kk),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, vecGet(v, b('+', i, off)))],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_no_na') {
    /**
     * "这条向量里不许有缺失" —— 有就当场报，没有原样回。
     *
     * 给 `quantile` 用：R 在 `na.rm = FALSE`（默认）时碰上 `NA` 是**报错**
     * （"missing values and NaN's not allowed if 'na.rm' is FALSE"），而我们的 `r_sort`
     * 会把缺失悄悄丢掉 —— 那就成了"少几格数据算出来的分位数"，是静默答错。
     */
    return {
      kind: 'fn', name, params: P, ret: RVEC,
      body: [
        {
          kind: 'if',
          cond: { kind: 'call', fn: { kind: 'name', name: useFn('r_any_na') }, args: [v] },
          then: [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{
              kind: 'string',
              value: "quantile(): 这条向量里有 NA，而 na.rm = FALSE —— R 那边也报"
                + "（missing values and NaN's not allowed if 'na.rm' is FALSE）",
            }],
          }],
          else_: null,
        },
        { kind: 'return', values: [v] },
      ],
    };
  }
  if (name === 'r_zap') {
    /**
     * `zapsmall(x, digits)` —— 照 R 的定义（`base::zapsmall`）：
     *
     * ```r
     * mx <- max(abs(x), na.rm = TRUE)
     * round(x, digits = if (mx > 0) max(0L, digits - as.numeric(log10(mx))) else digits)
     * ```
     *
     * 也就是"按最大那一格的量级把位数让出去"，于是 `zapsmall(c(1e-20, 1))` 出 `0 1`。
     * 取整走 R 自己的 `fround`（那是 `round` 的正本，见 `RMATH`），**位数是个小数**
     * （`digits - log10(mx)`），`fround` 内部再 `floor(digits + 0.5)` 收成整数 ——
     * 照它办，不自己先取整。
     *
     * 一处明写的不足：`log10` 在 JS 腿上是 V8 的实现，与本机 libm 可能差 1 ulp ——
     * 只有 `digits - log10(mx)` 正好落在 `k + 0.5` 的 1 ulp 之内时才会让 `fround` 收到
     * 不同的位数。碰得到的话那一格会与 R 差一位（这一族的账在 SPEC 第三节）。
     */
    cabiUsed.add('fround');
    rmathSig('fround');
    const out = { kind: 'name', name: 'o' };
    const mx = { kind: 'name', name: 'mx' };
    const dg = { kind: 'name', name: 'dg' };
    const av = { kind: 'name', name: 'av' };
    const rm = (f, e) => call1('rmath', { kind: 'strlit', value: f }, e);
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'dig', type: REAL }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'mx', type: REAL, init: { kind: 'real', value: 0 } },
        loop([
          { kind: 'let', name: 'av', type: REAL, init: rm('fabs', elem) },
          {
            kind: 'if',
            cond: b('&&', { kind: 'unop', op: '!', operand: naQ(av) }, b('>', av, mx)),
            then: [{ kind: 'assign', target: mx, value: av }],
            else_: null,
          },
        ], 0),
        { kind: 'let', name: 'dg', type: REAL, init: { kind: 'name', name: 'dig' } },
        {
          kind: 'if',
          cond: b('>', mx, { kind: 'real', value: 0 }),
          then: [
            { kind: 'assign', target: dg, value: b('-', { kind: 'name', name: 'dig' }, rm('log10', mx)) },
            {
              kind: 'if',
              cond: b('<', dg, { kind: 'real', value: 0 }),
              then: [{ kind: 'assign', target: dg, value: { kind: 'real', value: 0 } }],
              else_: null,
            },
          ],
          else_: null,
        },
        ...vecNewAs('o', len),
        loop([vecSet(out, i, { kind: 'ccall', sym: 'fround', args: [elem, dg] })], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_qdef') {
    /** `quantile` 不给 `probs` 时的那五格（R 的默认 `seq(0, 1, 0.25)`）。 */
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn', name, params: [], ret: RVEC,
      body: [
        ...vecNewAs('o', { kind: 'int', value: 5 }),
        ...[0, 0.25, 0.5, 0.75, 1].map((q, k) => vecSet(out, { kind: 'int', value: k }, { kind: 'real', value: q })),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_quantile') {
    /**
     * `quantile(x, probs)` —— R 的**默认 type 7**（`?quantile` 的第七种，也是 `median`
     * 那一条）。照 `quantile.default` 抄：
     *
     * ```r
     * index <- 1 + (n - 1) * probs
     * lo <- floor(index); hi <- ceiling(index)
     * qs <- x[lo]
     * i <- which(index > lo & x[hi] != qs)
     * h <- (index - lo)[i]
     * qs[i] <- (1 - h) * qs[i] + h * x[hi][i]
     * ```
     *
     * 两处照抄不改写：**`(1-h)*a + h*b`**（不是 `a + h*(b-a)` —— 那两种写法在最后一位
     * 上会分家）与 **`x[hi] != qs` 那道闸门**（相等时一个字都不动，于是 `h` 是 0 那几格
     * 不会去乘 0）。
     *
     * `probs` 出了 `[0, 1]` 当场报（R 那边也报）。缺失那一格在调用点上拦（R 的
     * `na.rm = FALSE` 是报错，不是悄悄丢掉 —— 而我们的 `r_sort` 会丢）。
     */
    const w = { kind: 'name', name: 'w' };
    const sv = { kind: 'name', name: 'q' };
    const out = { kind: 'name', name: 'o' };
    const j = { kind: 'name', name: 'j' };
    const idx = { kind: 'name', name: 'ix' };
    const lo = { kind: 'name', name: 'lo' };
    const hi = { kind: 'name', name: 'hi' };
    const a1 = { kind: 'name', name: 'a1' };
    const b1 = { kind: 'name', name: 'b1' };
    const hh = { kind: 'name', name: 'h' };
    const rm = (f, e) => call1('rmath', { kind: 'strlit', value: f }, e);
    const at1 = (e) => vecGet(sv, b('-', call1('toint', e), { kind: 'int', value: 1 }));
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'w', type: RVEC }],
      ret: RVEC,
      body: [
        {
          kind: 'let',
          name: 'q',
          type: RVEC,
          init: { kind: 'call', fn: { kind: 'name', name: useFn('r_sort') }, args: [v] },
        },
        { kind: 'let', name: 'n', type: INT, init: vecLen(sv) },
        { kind: 'let', name: 'm', type: INT, init: vecLen(w) },
        ...vecNewAs('o', { kind: 'name', name: 'm' }),
        {
          kind: 'for',
          init: { kind: 'let', name: 'j', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', j, { kind: 'name', name: 'm' }),
          post: { kind: 'assign', target: j, value: b('+', j, { kind: 'int', value: 1 }) },
          body: [
            {
              kind: 'if',
              cond: b('||', b('<', vecGet(w, j), { kind: 'real', value: 0 }),
                b('>', vecGet(w, j), { kind: 'real', value: 1 })),
              then: [{
                kind: 'builtin-stmt',
                name: 'fail',
                args: [{ kind: 'string', value: "quantile(): probs 出了 [0, 1]（R 那边也报 'probs' outside [0,1]）" }],
              }],
              else_: null,
            },
            {
              kind: 'let',
              name: 'ix',
              type: REAL,
              init: b('+', { kind: 'real', value: 1 },
                b('*', call1('toreal', b('-', { kind: 'name', name: 'n' }, { kind: 'int', value: 1 })), vecGet(w, j))),
            },
            { kind: 'let', name: 'lo', type: REAL, init: rm('floor', idx) },
            { kind: 'let', name: 'hi', type: REAL, init: rm('ceil', idx) },
            { kind: 'let', name: 'a1', type: REAL, init: at1(lo) },
            { kind: 'let', name: 'b1', type: REAL, init: at1(hi) },
            {
              kind: 'if',
              cond: b('&&', b('>', idx, lo), b('!=', b1, a1)),
              then: [
                { kind: 'let', name: 'h', type: REAL, init: b('-', idx, lo) },
                vecSet(out, j, b('+', b('*', b('-', { kind: 'real', value: 1 }, hh), a1), b('*', hh, b1))),
              ],
              else_: [vecSet(out, j, a1)],
            },
          ],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_cov' || name === 'r_cor') {
    /**
     * `cov(x, y)`（也就是 `var(x, y)`）与 `cor(x, y)` —— 都是**样本**口径（除 n-1）。
     *
     * 两条一样长才算：R 那边长度不一样是报错（`incompatible dimensions`），这儿也
     * 当场停下来，不按回收凑。
     *
     * `cor` 的分母照 R 自己那份 `src/main/cov.c`：**两个 `sqrt` 分开算再相乘**
     * （`sd_x * sd_y`，不是 `sqrt(varx * vary)`）—— 那两种写法在最后一位上会分家，
     * 而这一族的判据是逐字节。
     */
    const call = (fnName, ...as) => ({ kind: 'call', fn: { kind: 'name', name: useFn(fnName) }, args: as });
    const w = { kind: 'name', name: 'w' };
    const P2 = [{ name: 'v', type: RVEC }, { name: 'w', type: RVEC }];
    if (name === 'r_cor') {
      const sq = (e) => call1('rmath', { kind: 'strlit', value: 'sqrt' }, e);
      return {
        kind: 'fn',
        name,
        params: P2,
        ret: REAL,
        body: [{
          kind: 'return',
          values: [b('/', call('r_cov', v, w), b('*', sq(call('r_var', v)), sq(call('r_var', w))))],
        }],
      };
    }
    const mv = { kind: 'name', name: 'mv' };
    const mw = { kind: 'name', name: 'mw' };
    return {
      kind: 'fn',
      name,
      params: P2,
      ret: REAL,
      body: [
        declLen(),
        {
          kind: 'if',
          cond: b('!=', vecLen(w), len),
          then: [{
            kind: 'builtin-stmt',
            name: 'fail',
            args: [{ kind: 'string', value: 'cov/cor(): 两条向量长度不一样（R 那边也报 incompatible dimensions）' }],
          }],
          else_: null,
        },
        { kind: 'let', name: 'mv', type: REAL, init: call('r_mean', v) },
        { kind: 'let', name: 'mw', type: REAL, init: call('r_mean', w) },
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 0 } },
        /* 与 `r_var` 同一条：R 那边 `sum += (x-mx)*(y-my)` 被收缩成 `fmadd`，
           所以这儿也走方言那一格精确的 `fma`（见 `r_var` 上那段账）。 */
        loop([
          { kind: 'let', name: 'dv', type: REAL, init: b('-', elem, mv) },
          { kind: 'let', name: 'dw', type: REAL, init: b('-', vecGet(w, i), mw) },
          {
            kind: 'assign',
            target: acc,
            value: call1('rmath', { kind: 'strlit', value: 'fma' },
              { kind: 'name', name: 'dv' }, { kind: 'name', name: 'dw' }, acc),
          },
        ], 0),
        {
          kind: 'return',
          values: [b('/', acc, call1('toreal', b('-', len, { kind: 'int', value: 1 })))],
        },
      ],
    };
  }
  if (name === 'r_var' || name === 'r_sd') {
    /* `var` 是**样本**方差（除 n-1），`sd` 是它的平方根。缺失按浮点自然传播。 */
    const mu = { kind: 'name', name: 'mu' };
    const call = (fnName, ...as) => ({ kind: 'call', fn: { kind: 'name', name: useFn(fnName) }, args: as });
    if (name === 'r_sd') {
      return {
        kind: 'fn', name, params: P, ret: REAL,
        body: [{ kind: 'return', values: [call1('rmath', { kind: 'strlit', value: 'sqrt' }, call('r_var', v))] }],
      };
    }
    return {
      kind: 'fn', name, params: P, ret: REAL,
      body: [
        declLen(),
        { kind: 'let', name: 'mu', type: REAL, init: call('r_mean', v) },
        { kind: 'let', name: 's', type: REAL, init: { kind: 'real', value: 0 } },
        /* **用 `fma` 累加**，不是 `s + d*d`。理由是量出来的：R 那边这一句
           （`src/library/stats/src/cov.c` 的 `sum += (x-m)*(x-m)`）被 clang 在 arm64 上
           收缩成一条 `fmadd`（单次舍入），朴素写法差 1 ulp ——
           `var(c(1/3,2/7,3/11,4/13,5/17,6/19,7/23))` R 是 `…969429`、朴素式是 `…969418`。
           方言的 `(rmath "fma" …)` 在五条腿上都是**精确**的那一版（ADR-0014 第十五节：
           JS 那侧是 Dekker 拆分 + two-sum，C 那侧就是 `fmadd`），所以这条路对得上。 */
        loop([
          { kind: 'let', name: 'd', type: REAL, init: b('-', elem, mu) },
          {
            kind: 'assign',
            target: acc,
            value: call1('rmath', { kind: 'strlit', value: 'fma' },
              { kind: 'name', name: 'd' }, { kind: 'name', name: 'd' }, acc),
          },
        ], 0),
        {
          kind: 'return',
          values: [b('/', acc, call1('toreal', b('-', len, { kind: 'int', value: 1 })))],
        },
      ],
    };
  }
  if (name === 'r_rep_s' || name === 'r_rep_v') {
    /* `rep(x, k)`：标量那一档出 k 格，向量那一档把整条重复 k 遍。 */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    if (name === 'r_rep_s') {
      return {
        kind: 'fn',
        name,
        params: [{ name: 'x', type: REAL }, { name: 'k', type: INT }],
        ret: RVEC,
        body: [
          ...vecNewAs('o', kk),
          {
            kind: 'for',
            init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
            cond: b('<', i, kk),
            post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
            body: [vecSet(out, i, { kind: 'name', name: 'x' })],
          },
          { kind: 'return', values: [out] },
        ],
      };
    }
    const m = { kind: 'name', name: 'm' };
    const e = { kind: 'name', name: 'e' };
    const w = { kind: 'name', name: 'w' };
    /* `rep(v, times = k, each = e)` —— R 的次序是**先 each 再 times**
       （`rep(c(1,2), times=2, each=3)` 是 `1 1 1 2 2 2 1 1 1 2 2 2`，量出来的）。
       三层循环而不是一格 `v[(i % (n*e)) / e]`：方言里两格 int 相除是不是整除这一层
       不打包票（见 `printFnDecl` 里 `per` 那段账），而这儿要的正是整除。 */
    const inner = (body) => ({
      kind: 'for',
      init: { kind: 'let', name: 'q', type: INT, init: { kind: 'int', value: 0 } },
      cond: b('<', { kind: 'name', name: 'q' }, e),
      post: {
        kind: 'assign',
        target: { kind: 'name', name: 'q' },
        value: b('+', { kind: 'name', name: 'q' }, { kind: 'int', value: 1 }),
      },
      body,
    });
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'k', type: INT }, { name: 'e', type: INT }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'm', type: INT, init: b('*', b('*', len, kk), e) },
        ...vecNewAs('o', m),
        { kind: 'let', name: 'w', type: INT, init: { kind: 'int', value: 0 } },
        {
          kind: 'for',
          init: { kind: 'let', name: 't', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', { kind: 'name', name: 't' }, kk),
          post: {
            kind: 'assign',
            target: { kind: 'name', name: 't' },
            value: b('+', { kind: 'name', name: 't' }, { kind: 'int', value: 1 }),
          },
          body: [{
            kind: 'for',
            init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
            cond: b('<', i, len),
            post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
            body: [inner([
              vecSet(out, w, vecGet(v, i)),
              { kind: 'assign', target: w, value: b('+', w, { kind: 'int', value: 1 }) },
            ])],
          }],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_seq_n') {
    /* `seq(from, to, length.out = k)` —— 步长是 `(to-from)/(k-1)`，第 i 格是
       `from + i*step`，**最后一格写成 `to`**（R 的 C 也是这么收的口径，`seq.c`）。
       `k == 1` 只出 `from`、`k <= 0` 出零长（R 那两格也是这么答的）。 */
    const out = { kind: 'name', name: 'o' };
    const from = { kind: 'name', name: 'a' };
    const to = { kind: 'name', name: 'z' };
    const kn = { kind: 'name', name: 'k' };
    const st = { kind: 'name', name: 'st' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: REAL }, { name: 'z', type: REAL }, { name: 'k', type: INT }],
      ret: RVEC,
      body: [
        {
          kind: 'if',
          cond: b('<=', kn, { kind: 'int', value: 0 }),
          then: [...vecNewAs('e0', { kind: 'int', value: 0 }),
            { kind: 'return', values: [{ kind: 'name', name: 'e0' }] }],
          else_: null,
        },
        ...vecNewAs('o', kn),
        {
          kind: 'if',
          cond: b('==', kn, { kind: 'int', value: 1 }),
          then: [vecSet(out, { kind: 'int', value: 0 }, from), { kind: 'return', values: [out] }],
          else_: null,
        },
        {
          kind: 'let',
          name: 'st',
          type: REAL,
          init: b('/', b('-', to, from), call1('toreal', b('-', kn, { kind: 'int', value: 1 }))),
        },
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, kn),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, b('+', from, b('*', call1('toreal', i), st)))],
        },
        vecSet(out, b('-', kn, { kind: 'int', value: 1 }), to),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_seq_by') {
    /* `seq(from, to, by)`：长度照 R 的算法 `floor((to-from)/by + 1e-10) + 1`
       （`seq.default` 里那个 fuzz 是 R 自己的 —— 不加的话 `seq(0, 1, 0.1)` 会少一格）。 */
    const out = { kind: 'name', name: 'o' };
    const from = { kind: 'name', name: 'a' };
    const to = { kind: 'name', name: 'z' };
    const by = { kind: 'name', name: 'by' };
    const m = { kind: 'name', name: 'm' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'a', type: REAL }, { name: 'z', type: REAL }, { name: 'by', type: REAL }],
      ret: RVEC,
      body: [
        {
          kind: 'let',
          name: 'm',
          type: INT,
          init: b('+', call1('toint', call1('rmath', { kind: 'strlit', value: 'floor' },
            b('+', b('/', b('-', to, from), by), { kind: 'real', value: 1e-10 }))), { kind: 'int', value: 1 }),
        },
        {
          kind: 'if',
          cond: b('<', m, { kind: 'int', value: 1 }),
          then: [{ kind: 'builtin-stmt', name: 'fail', args: [{ kind: 'string', value: "wrong sign in 'by' argument" }] }],
          else_: null,
        },
        ...vecNewAs('o', m),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, m),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, b('+', from, b('*', call1('toreal', i), by)))],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_sample_i') {
    /* `sample.int(n, k)` —— 照 `do_sample`（不放回那一支）：手里一条 0..n-1 的牌，
       每次用 `R_unif_index` 抽一格、记下来（+1 变成 R 的下标）、再把**末尾那格**填进空位。
       与 R 逐位相同，因为抽数那一格就是 R 的 `R_unif_index`（拒绝采样）。 */
    cabiUsed.add('omni_r_unif_index');
    rmathSig('omni_r_unif_index');
    const nn = { kind: 'name', name: 'n0' };
    const kk = { kind: 'name', name: 'k' };
    const xs = { kind: 'name', name: 'x' };
    const out = { kind: 'name', name: 'o' };
    const m = { kind: 'name', name: 'm' };
    const j = { kind: 'name', name: 'j' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'n0', type: INT }, { name: 'k', type: INT }],
      ret: RVEC,
      body: [
        ...vecNewAs('x', nn),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, nn),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(xs, i, call1('toreal', i))],
        },
        ...vecNewAs('o', kk),
        { kind: 'let', name: 'm', type: INT, init: nn },
        {
          kind: 'for',
          init: { kind: 'let', name: 'i2', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', { kind: 'name', name: 'i2' }, kk),
          post: {
            kind: 'assign',
            target: { kind: 'name', name: 'i2' },
            value: b('+', { kind: 'name', name: 'i2' }, { kind: 'int', value: 1 }),
          },
          body: [
            {
              kind: 'let',
              name: 'j',
              type: INT,
              init: call1('toint', { kind: 'ccall', sym: 'omni_r_unif_index', args: [call1('toreal', m)] }),
            },
            vecSet(out, { kind: 'name', name: 'i2' }, b('+', vecGet(xs, j), { kind: 'real', value: 1 })),
            { kind: 'assign', target: m, value: b('-', m, { kind: 'int', value: 1 }) },
            vecSet(xs, j, vecGet(xs, m)),
          ],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_zeros') {
    /* `numeric(n)` / `logical(n)`：n 格零（`vecNewAs` 开出来的内存不保证是零，所以要写一遍）。 */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'k', type: INT }],
      ret: RVEC,
      body: [
        ...vecNewAs('o', kk),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, kk),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, { kind: 'real', value: 0 })],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_iota') {    /* `seq_along(字符向量)` 要的那一格：`1 … k` 一条数值向量（长度从 `alen` 来）。 */
    const out = { kind: 'name', name: 'o' };
    const kk = { kind: 'name', name: 'k' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'k', type: INT }],
      ret: RVEC,
      body: [
        ...vecNewAs('o', kk),
        {
          kind: 'for',
          init: { kind: 'let', name: 'i', type: INT, init: { kind: 'int', value: 0 } },
          cond: b('<', i, kk),
          post: { kind: 'assign', target: i, value: b('+', i, { kind: 'int', value: 1 }) },
          body: [vecSet(out, i, call1('toreal', b('+', i, { kind: 'int', value: 1 })))],
        },
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_vec1') {
    /* 一格数 → 长度 1 的向量。`ifelse` 那一格要它：把标量实参先摆成向量，
       于是回收那一层只写一遍（R 的 `ifelse(t, 0, 1)` 与 `ifelse(t, xs, ys)` 同一条路）。 */
    const out = { kind: 'name', name: 'o' };
    return {
      kind: 'fn',
      name,
      params: [{ name: 'x', type: REAL }],
      ret: RVEC,
      body: [
        ...vecNewAs('o', { kind: 'int', value: 1 }),
        vecSet(out, { kind: 'int', value: 0 }, { kind: 'name', name: 'x' }),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_ifelse') {
    /* `ifelse(test, yes, no)`：**结果的长度是 test 的长度**，`yes` / `no` 按回收取
       （R 的文档原话："the result has the shape of test"）。test 那一格缺失就交缺失。 */
    const t = { kind: 'name', name: 'v' };
    const y = { kind: 'name', name: 'y' };
    const z = { kind: 'name', name: 'z' };
    const out = { kind: 'name', name: 'o' };
    const ny = { kind: 'name', name: 'ny' };
    const nz = { kind: 'name', name: 'nz' };
    const ti = vecGet(t, i);
    return {
      kind: 'fn',
      name,
      params: [{ name: 'v', type: RVEC }, { name: 'y', type: RVEC }, { name: 'z', type: RVEC }],
      ret: RVEC,
      body: [
        declLen(),
        { kind: 'let', name: 'ny', type: INT, init: vecLen(y) },
        { kind: 'let', name: 'nz', type: INT, init: vecLen(z) },
        ...vecNewAs('o', len),
        loop([{
          kind: 'if',
          cond: naQ(ti),
          then: [vecSet(out, i, { kind: 'call', fn: { kind: 'name', name: useFn('r_na') }, args: [] })],
          else_: [{
            kind: 'if',
            cond: b('!=', ti, { kind: 'real', value: 0 }),
            then: [vecSet(out, i, vecGet(y, b('%', i, ny)))],
            else_: [vecSet(out, i, vecGet(z, b('%', i, nz)))],
          }],
        }], 0),
        { kind: 'return', values: [out] },
      ],
    };
  }
  if (name === 'r_substr' || name === 'r_starts' || name === 'r_ends'
      || name === 'r_padl' || name === 'r_padr' || name === 'r_pad0' || name === 'r_lower'
      || name === 'r_trim' || name === 'r_chartr' || name === 'r_format1') {
    return strFnDecl(name);
  }
  if (STRV_FNS.has(name)) return strvFnDecl(name);
  if (SET_FNS.has(name)) return setFnDecl(name);
  if (name === 'r_sci') return sciFnDecl();
  if (name === 'r_num_fmt' || name === 'r_print_num' || name === 'r_print_lgl'
      || name === 'r_print_named') {
    return printFnDecl(name);
  }
  if (name === NUM_STR) return numStrDecl();
  throw new Error(`r->IR: 不认识的辅助函数 ${name}`);
}

/**
 * 按 `FN_DEPS` 把要发的那批函数闭包起来，回**倒序**的名字表
 * （`decls.unshift` 一个一个往前插，所以倒着给才是正序）。
 * 表里没登记的名字当场报 —— 那说明有人加了一格辅助函数却忘了写它依赖谁。
 */
function closeFns(want) {
  const out = new Set();
  const visit = (name) => {
    if (out.has(name)) return;
    const deps = FN_DEPS.get(name);
    if (deps === undefined) throw new Error(`r->IR: 辅助函数 ${name} 没登记在 FN_DEPS 里`);
    out.add(name);
    for (const d of deps) visit(d);
  };
  for (const n of want) visit(n);
  return [...out].sort().reverse();
}

/** 这条语句（或它里头）有没有一格**带值的** `return`。 */function hasValueReturn(s) {
  if (s === null || s === undefined) return false;
  if (s.kind === 'return') return s.values.length > 0;
  for (const k of ['then', 'else_', 'body', 'stmts']) {
    const v = s[k];
    if (Array.isArray(v) && v.some((y) => hasValueReturn(y))) return true;
  }
  if (s.kind === 'for' && (hasValueReturn(s.init) || hasValueReturn(s.post))) return true;
  return false;
}

/** 一格函数（`(fn (formals …) 体)`）→ 标准 IR 的 `fn`。 */
function fnDecl(name, node, types) {
  const formals = kids(node)[0];
  const params = kids(formals).map((f) => mangle(nameOf(kids(f)[0])));
  const body = kids(node)[1];
  /* 形参类型来自 `inferFns()` 扫出来的那张表（表外 —— 没人调过 —— 才落 int）。 */
  const seed = new Map((fnParams.get(name) ?? []).map((t, k) => [params[k], t]));
  const local = inferTypes(body, params, seed);
  /* **先定住"这个函数交什么"**，再发它的体 —— 每一处 `return` 要按它对齐（见 `retVal`）。 */
  curRet = fnRets.get(name) ?? null;
  const stmts = tailBody(body, local);
  curRet = null;
  const decls = [];
  for (const [n, t] of local) {
    if (params.includes(n)) continue;
    decls.push({ kind: 'let', name: n, type: t, init: zeroInit(t) });
    decls.push(...zeroStmts(n, t));
    /* 带名字的向量：名字那一条摆在影子变量里（见 `RNVEC`），跟着这格 `let` 一起声明。 */
    if (isNamedTy(t)) {
      decls.push({ kind: 'let', name: nmVar(n), type: RSTRV, init: zeroInit(RSTRV) });
    }
  }
  const all = [...decls, ...stmts];
  /* 回什么：拿最后那一格带值的 `return` 里的表达式类型算（`local` 已经推完了）。 */
  const ret = all.some((s) => hasValueReturn(s)) ? (returnType(body, local) ?? INT) : { kind: 'void' };
  return {
    kind: 'fn',
    name,
    params: params.map((p) => ({ name: p, type: local.get(p) ?? INT })),
    ret,
    body: all,
  };
}

/** 函数回的是什么：body 里所有"尾位表达式"与 `return(x)` 的类型合起来（串赢）。 */
function returnType(body, types) {
  const seen = [];
  const walkTail = (x) => {
    switch (tag(x)) {
      case 'block': { const ks = kids(x); if (ks.length > 0) walkTail(ks[ks.length - 1]); return; }
      case 'paren': walkTail(kids(x)[0]); return;
      case 'if': { const ks = kids(x); walkTail(ks[1]); if (ks[2] !== undefined) walkTail(ks[2]); return; }
      case 'for': case 'while': case 'repeat': case 'break': case 'next': return;
      case 'bin': case 'bin-rev': if (isAssign(x)) return; seen.push(typeOfExpr(x, types)); return;
      case 'call': {
        const fn = tag(kids(x)[0]) === 'sym' ? nameOf(kids(x)[0]) : null;
        if (fn === 'cat') return;
        /* `switch` 交的是**被选中那一支**的东西 —— 所以往每一支里看，不问 `switch` 本身。
           每一支都是 `cat(…)` 那种"做事不交值"的，这个函数就回 void。 */
        if (fn === 'switch') {
          for (const a of argsOf(x).slice(1)) if (a.value !== null) walkTail(a.value);
          return;
        }
        seen.push(typeOfCall(x, types));
        return;
      }
      default: seen.push(typeOfExpr(x, types));
    }
  };
  walkTail(body);
  /* `return(x)` 那一族：走遍整棵树把它们也算进来。 */
  const walkAll = (x) => {
    if (!isList(x)) return;
    if (tag(x) === 'call' && tag(kids(x)[0]) === 'sym' && nameOf(kids(x)[0]) === 'return') {
      const vs = posArgs(x);
      if (vs.length > 0) seen.push(typeOfExpr(vs[0], types));
    }
    for (const k of kids(x)) walkAll(k);
  };
  walkAll(body);
  /* 一处带值的尾位都没有 → `null`（"这个函数不交值"）。调用方各自决定那是 `void`
     还是 int：`fnDecl` 那边已经按 `hasValueReturn` 判过一遍，`inferFns` 要的是 void
     —— 顶层自动印靠它分"要不要印"（`f <- function(x) cat(x)` 印不出东西来）。 */
  if (seen.length === 0) return null;
  /* 字符向量要摆在标量串**前面** —— 两者都"是串"，而混着写（一支回向量、一支回一格串）
     在这一档合不起来，留向量那一个（调用点上它才是能接着用的那格）。 */
  if (seen.some((t) => isStrVec(t))) return RSTRV;
  if (seen.some((t) => t.kind === 'string')) return STR;
  if (seen.some((t) => isVecTy(t) || t.kind === 'map')) {
    const got = seen.find((t) => isVecTy(t) || t.kind === 'map');
    /* **交一格带名字的向量出不去** —— 名字那一条是跟着变量走的（见 `RNVEC`），
       跟不出函数。静默丢掉的话调用点上 `print` 会少印名字那一行，所以当场报。 */
    if (isNamedTy(got)) {
      throw new Error('r->IR: 函数交一格**带名字的向量**还没接 —— 名字那一条跟着变量走，'
        + '出不了函数（见 ext/r/SPEC.md 第二节）。要带名字就在调用点上装回去：'
        + '`setNames(f(…), ns)`');
    }
    return got;
  }
  /* **三态逻辑要留住那个记号**：`f <- function(x) x > 2` 回的是逻辑，不是普通 double
     （丢了它 `cat(f(1))` 会印 `1` / `0` 而不是 `TRUE` / `FALSE`）。
     每一处尾位都是三态才算 —— 混着数出来的那种（一支 `x > 2`、一支 `0`）按数算。 */
  if (seen.every((t) => isLgl1(t))) return RLGL1;
  if (seen.some((t) => t.kind === 'real')) return REAL;
  if (seen.every((t) => t.kind === 'bool')) return BOOL;
  return INT;
}

/**
 * 一棵 R 的 GLR 树（`(program 项…)`）→ 标准 IR 的模块。
 *
 * **函数是值**（文件头第 1 条）：顶层那些 `名字 <- function(…) …` 提升成 `fn`，
 * 别的落进 `main`。提升要先走一遍 —— `main` 里的类型推断会问"这个调用回什么"，
 * 而那要函数表先在（`fact` 递归调自己就是这一格）。
 */
export function rToIR(tree) {
  if (tag(tree) !== 'program') throw new Error('r->IR: 这不是 (program …)');
  tmpN = 0;
  cabiUsed.clear();
  needFn.clear();
  fnParams.clear();
  fnRets.clear();
  fnDefs.clear();
  fnFormals.clear();
  globalTys.clear();
  const items = kids(tree);
  const fns = [];
  const rest = [];
  for (const item of items) {
    if (isAssign(item)) {
      const { target, value } = assignParts(item);
      if (tag(target) === 'sym' && tag(value) === 'fn') {
        fns.push({ name: mangle(nameOf(target)), node: value });
        continue;
      }
    }
    rest.push(item);
  }
  /* apply 那一族里"给的是一个函数名字"那种写法**先就地改写**成匿名函数
     （见 `nameToLambda`）—— 要摆在 `inferFns` 之前：那一遍靠合成出来的那个调用点
     才推得出被点名那个函数的形参装什么。 */
  const userFns = new Set(fns.map((f) => f.name));
  for (const item of items) nameToLambda(item, userFns);
  /* **先把用户函数的形参与返回类型推出来**（扫调用点，转三轮）—— 发之前必须定住，
     不然 `half(3)` 里 `x` 还是 int，而函数体里 `x / 2` 已经按 real 发了。 */
  inferFns(fns, rest);
  const decls = fns.map((f) => fnDecl(f.name, f.node, new Map()));  /* 顶层剩下的那些：拼成一格假的 `(block …)` 交给同一条推断与同一条降级。 */
  const mainBlock = { kind: 'list', items: [{ kind: 'atom', value: 'block' }, ...rest] };
  const types = inferTypes(mainBlock, []);
  const stmts = rest.map((k) => topStmtOf(k, types));
  const lets = [];
  for (const [n, t] of types) {
    /* 被函数用到的那几格是**模块级变量**（见 `globalTys`）：这儿不发 `let`，
       只在 `main` 开头把零值摆好（方言的 `(global …)` 按设计没有初值）。
       **标量不用摆** —— `(global …)` 本来就是零起步，而源里那句 `x <- …` 紧跟着就到；
       要摆的只有向量与表那两格（它们得先有一块地方，`zeroInit` 答 null 就是"没有"）。 */
    if (globalTys.has(n)) {
      const z = zeroInit(t);
      if (z !== null) {
        lets.push({ kind: 'assign', target: { kind: 'name', name: n }, value: z });
        lets.push(...zeroStmts(n, t));
      }
      if (isNamedTy(t)) {
        lets.push({
          kind: 'assign', target: { kind: 'name', name: nmVar(n) }, value: zeroInit(RSTRV),
        });
      }
      continue;
    }
    lets.push({ kind: 'let', name: n, type: t, init: zeroInit(t) });
    lets.push(...zeroStmts(n, t));
    /* 名字那一条的影子变量（见 `RNVEC`）。 */
    if (isNamedTy(t)) {
      lets.push({ kind: 'let', name: nmVar(n), type: RSTRV, init: zeroInit(RSTRV) });
    }
  }
  decls.push({ kind: 'main', body: [...lets, ...stmts] });
  /* 模块级变量的声明摆在最前（函数体与 `main` 都可能提到它们）。 */
  for (const [n, t] of [...globalTys].sort((p, q) => (p[0] < q[0] ? -1 : 1)).reverse()) {
    const gt = types.get(n) ?? t;
    if (isNamedTy(gt)) decls.unshift({ kind: 'global', name: nmVar(n), type: RSTRV });
    decls.unshift({ kind: 'global', name: n, type: gt });
  }
  /* 生成出来的辅助函数：**先按 `FN_DEPS` 闭包**，再一次发完（次序与"谁先被点到"无关）。
     摆在 `main` 之前、按名字排 —— 出来的 `.sx` 要能进快照。 */
  for (const name of closeFns(needFn)) {
    if (NA_FNS.has(name)) decls.unshift(naFnDecl(name));
    else if (LGL_FNS.has(name)) decls.unshift(lglFnDecl(name));
    else decls.unshift(vecFnDecl(name));
  }

  /* **自动 FFI 的那几行**（模块头上）。只发这一趟真用到的符号 —— 一份 271 条声明的头
     全发出来的话，`.sx` 会被 271 行 `(cabi …)` 淹掉，而没用到的那些还要求链接期真有它们。
     次序照名字排：出来的 `.sx` 要能进快照，不能随 Map 的插入序变。 */
  const ffi = [];
  if (cabiUsed.size > 0) {
    ffi.push({ kind: 'lib', name: rmathLib() });
    for (const sym of [...cabiUsed].sort()) {
      const sig = rmathSig(sym);
      ffi.push({ kind: 'cabi', sym, ret: sig.ret, params: sig.params });
    }
  }
  return { kind: 'module', decls: [...ffi, ...decls] };
}





