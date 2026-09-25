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
