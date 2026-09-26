# ext/r/examples/rmath.R —— **R 的数值由 R 自己的 C 答**（这一族只有 R 这一门有）
#
# 每一行都挑的是**我们自己算就会错**的那一格。判据是逐字节对 `Rscript`（tests/r/oracle.js），
# 而算的那一半来自 `libomniRmath` —— `ext/r/build.js` 拿 `r-source/src/nmath` 的 121 份 `.c`
# 编出来的，签名由 `rt/ffi.js` 从同一次构建生成的 `Rmath.h` 自动读（不手抄）。
#
#   round 是**到偶**（IEC 60559）：0.5 -> 0、2.5 -> 2、-1.5 -> -2，不是"四舍五入"
#   round(2.675, 2) -> 2.67：二进制里 2.675 比它看起来小一点，R 不替你圆过去
#   signif 是**有效位数**（`fprec.c`），与 round 是两件事
#   `%%` 随**除数**取号：-7 %% 3 是 2、7 %% -3 是 -2（C 的 `%` 给 -1 和 1）
#   `^` 走 `R_pow`：整数指数反复平方
#   dnorm / pnorm / qnorm / gamma / lgamma / lbeta / choose / log1p 全是 nmath 的函数
#
# 印出来只有 7 位有效数字 —— 那是 R 的 `cat` 对 double 的口径（`digits = 7`），不是我们截的。

cat(round(0.5), "\n", sep = "")
cat(round(2.5), "\n", sep = "")
cat(round(-1.5), "\n", sep = "")
cat(round(2.675, 2), "\n", sep = "")
cat(signif(123456, 3), "\n", sep = "")
cat(signif(3.14159265, 4), "\n", sep = "")
cat(trunc(-2.7), "\n", sep = "")
cat(-7 %% 3, "\n", sep = "")
cat(7 %% -3, "\n", sep = "")
cat(-7 %/% 3, "\n", sep = "")
cat(2^10, "\n", sep = "")
cat(2^0.5, "\n", sep = "")
cat(dnorm(1), "\n", sep = "")
cat(pnorm(1.96), "\n", sep = "")
cat(qnorm(0.975), "\n", sep = "")
cat(gamma(5), "\n", sep = "")
cat(lgamma(100), "\n", sep = "")
cat(lbeta(3, 4), "\n", sep = "")
cat(choose(10, 3), "\n", sep = "")
cat(log1p(1e-10), "\n", sep = "")
# `factorial(x)` 在 R 里就**定义成** `gamma(x + 1)` —— 所以非整数也有值
cat(factorial(5), "\n", sep = "")
cat(factorial(0), "\n", sep = "")
cat(factorial(10), "\n", sep = "")
cat(factorial(2.5), "\n", sep = "")
print(factorial(c(3, 4)))

# **缺失进这一族**（2026-09-26）：nmath 每个函数开头都是 `if (ISNAN(x)) return x + digits;`。
# C 那条腿上那句是对的 —— 硬件把第一个 NaN 操作数的**载荷**带出来，`NA` 还是 `NA`。
# JS 那条腿上 `NaN + 0` 是规范化的 NaN，载荷没了，同一份源码会印成 `NaN`。
# 所以现在在**进 nmath 之前**拦：谁是缺失就把那一格原样交回去 —— `NA` 与 `NaN` 分得开。
cat(round(NA), signif(NA), trunc(NA), sign(NA), "\n")
cat(round(NaN), signif(NaN), trunc(NaN), sign(NaN), "\n")
cat(gamma(NA), lgamma(NA), factorial(NA), factorial(NaN), "\n")
cat(beta(NA, 2), beta(2, NA), choose(NA, 2), choose(5, NA), "\n")
cat(log1p(NA), expm1(NA), dnorm(NA), pnorm(NA), qnorm(NA), "\n")
cat(dnorm(0, NA), dbinom(NA, 10, 0.5), dpois(NA, 1), "\n")
cat(pmax(NA, 1), pmin(1, NA), "\n")
cat(round(c(NA, 1.5)), signif(c(NA, 1.23456)), "\n")
cat(gamma(c(NA, 4)), factorial(c(NA, 4)), sign(c(NA, -3, 0, 2)), "\n")
cat(is.na(round(NA)), is.nan(round(NaN)), is.na(round(NaN)), is.nan(round(NA)), "\n")

# `^` 走 `R_pow`，缺失同一个毛病。拦的口径照 `R_pow` 的**头几句**抄，次序要紧：
#   if (x == 1. || y == 0.) return 1.;    所以 `NA ^ 0` 与 `1 ^ NA` 都是 1
#   if (x == 0.) { … else return y; }     所以 `0 ^ NA` 是 NA
cat(0 ^ NA, NA ^ 0, 1 ^ NA, NA ^ NA, NA ^ 2, 2 ^ NA, "\n")
cat(0 ^ NaN, NaN ^ 0, 1 ^ NaN, "\n")
cat(0 ^ -1, 0 ^ 2, Inf ^ 0, 0 ^ Inf, "\n")
cat(c(NA, 2) ^ 2, 2 ^ c(1, NA), c(0, 1) ^ NA, "\n")
cat(is.na(0 ^ NA), is.nan(0 ^ NaN), "\n")
print(c(NA, 2) ^ 2)

## log2 与 log(x, base=)：底 2 / 底 10 走 R 自己那两个特例（logbase()），别的走 log/log
cat(log2(8), log2(1024), log2(0.25), log2(2 ^ 53), "\n")
cat(log2(10), log2(NA), log2(0), "\n")
cat(log(8, base = 2), log(1000, base = 10), log(8, 2), log(100, 5), "\n")
lgb <- 3
cat(log(27, lgb), log(81, lgb), "\n")
lgb <- 2
cat(log(1024, lgb), "\n")
print(log2(c(1, 2, 4, 8)))
print(log(c(1, 2, 4, 8), base = 2))
print(log(c(1, 4, 16), 4))
## 底 2 那一档与"自己除一遍"**不是同一个答案** —— 末位差一格，所以照 R 分档
cat(sprintf("%.17g %.17g", log(10, 2), log(10) / log(2)), "\n")
cat(log(10, 2) == log(10) / log(2), "\n")
