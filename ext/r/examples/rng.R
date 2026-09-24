# ext/r/examples/rng.R —— 随机数：与 R **同一条流**
#
# 这一格从前刻意空着，理由写在 SPEC 里：standalone 的 nmath 自带的发生器是
# **Marsaglia-MultiCarry**，而 R 默认是 **Mersenne-Twister**，播种法也不一样 ——
# 接上去只会得到"看着像随机、每个数都不一样"，那是最难发现的错。
#
# 现在 `ext/r/rt/omni_rng.c` 把 MT19937 与 R 的播种法照 `src/main/RNG.c` 写出来、
# 顶掉了 `sunif.c`。于是：
#
#   * `set.seed(n)` 与 R 一样（先把种子过 50 遍 `69069 * s + 1` 搅一搅，再填满 625 格状态）；
#   * `runif` / `rnorm` / `rexp` / `rpois` / `rbinom` … 这一族**是 R 自己的代码**
#     （nmath 里的 `rnorm.c` / `rbinom.c` …）跑在 R 自己的流上 —— 所以数逐位相同；
#   * `sample()` 走 R >= 3.6 的 `R_unif_index`（拒绝采样）+ `do_sample` 的那条不放回算法。
#
# 没接的：`replace=` / `prob=`（Walker 别名法那一套）、`RNGkind()` 换发生器、
# `rgamma` / `rweibull` 那几个"R 那侧先换算参数"的（要按 `distn.R` 一条条核对）。

set.seed(42)
cat(runif(3), "\n")

set.seed(42)
cat(rnorm(3), "\n")

set.seed(1)
cat(runif(2, 10, 20), "\n")

set.seed(7)
cat(rnorm(2, 100, 15), "\n")

set.seed(3)
cat(rexp(3), "\n")

set.seed(5)
cat(rpois(5, 4), "\n")

set.seed(11)
cat(rbinom(5, 10, 0.5), "\n")

# 洗牌：`sample(n)` 是 1..n 的一个排列
set.seed(42)
cat(sample(10), "\n")
set.seed(42)
cat(sample(10, 3), "\n")

# 向量那一档：R 的 `sample(x)` 就是 `x[sample(length(x))]`
set.seed(99)
cat(sample(c(2.5, 3.5, 4.5)), "\n")

# 同一个种子取两趟一样，不同种子不一样
set.seed(8)
a <- runif(2)
set.seed(8)
b <- runif(2)
cat(a, "\n")
cat(b, "\n")
cat(all(a == b), "\n")

# 与那一族统计量凑起来（`round` 是 R 自己的 `fprec`）
set.seed(123)
print(round(runif(5), 4))
set.seed(2024)
xs <- rnorm(50)
cat(round(mean(xs), 6), "\n")
cat(round(sd(xs), 6), "\n")
cat(round(range(xs), 6), "\n")
