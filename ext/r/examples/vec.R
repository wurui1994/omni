# ext/r/examples/vec.R —— R 的数值向量与逻辑向量
#
# 存法：**一段线性内存**（`(ptr real)`），槽 0 放长度、槽 1..n 放元素。
# 不能用 `(arr real)` —— 那一格后端落成 JS 数组，而只装 double 的 JS 数组会把 NaN 的载荷
# 抹掉，于是 `c(1, NA, 3)` 会印成 `1 NaN 3`。五种存法量出来的结果在 `tests/r/oracle.js`
# 第三节钉着。
#
# 逐元素与**回收**是 R 的常态：结果长度取长的那一边，短的那边从头再来
# （`c(1,2,3,4) + c(10,20)` 是 `11 22 13 24`）。长的不是短的整倍数时 R 还会警告，
# 我们不发 —— 那要一条输出通道，这一版没有（明写在 SPEC）。
#
# 比较回的是**逻辑向量**，印 `TRUE` / `FALSE` / `NA`，不印 `1` / `0`；
# 而 `NA > 2` 与 `NaN > 2` 都是 `NA`（不是 `FALSE`），所以 `sum(zs > 2)` 也是 `NA`。

xs <- c(1, 2, 3, 4)
cat(xs, "\n")
cat(length(xs), "\n")
cat(xs + 1, "\n")
cat(xs * xs, "\n")
cat(xs / 2, "\n")
cat(10 - xs, "\n")
cat(xs + c(10, 20), "\n")
cat(sum(xs), mean(xs), max(xs), min(xs), "\n")
cat(xs > 2, "\n")
cat(sum(xs > 2), "\n")
xs[2] <- 9
cat(xs, "\n")
cat(xs[1], xs[4], "\n")
t <- 0
for (x in xs) t <- t + x * x
cat(t, "\n")
ys <- c(1, NA, 3)
cat(ys, "\n")
cat(is.na(ys[2]), is.na(ys[1]), "\n")
cat(ys > 2, "\n")
cat(ys == 3, "\n")
cat(sum(ys > 2), "\n")
cat(sum(c(0.5, 0.25)), "\n")

# `a:b` 当值用就是一格向量：步长 ±1、两头都含，`b < a` 时倒着数
# （`1:0` 是 `1 0` —— R 里有名的一格坑，不是空向量）。
cat(1:4, "\n")
cat(5:1, "\n")
cat(1:0, "\n")
cat(1.5:3, "\n")
n <- 3
cat(1:n, "\n")
cat(sum(1:10), "\n")
cat((1:3) * 2, "\n")

# `c(…)` 摊平实参里的向量 —— 长度是运行期才知道的
zs <- c(1:3, 9, xs)
cat(zs, "\n")
cat(length(zs), "\n")

# `^` 逐元素也走 R 自己的 `R_pow`，`%%` / `%/%` 走那条 floor 的算法（随除数取号）
cat((1:5)^2, "\n")
cat(2^(1:5), "\n")
cat(1:6 %% 3, "\n")
cat(1:6 %/% 3, "\n")
cat(c(-7, 7) %% 3, "\n")

# 下标也能是向量：逻辑向量按掩码挑（掩码短了从头再来，`NA` 挑出一格 `NA`）、
# 数值向量按位置挑。`c(TRUE, FALSE)` 本身就是一格逻辑向量。
cat(xs[xs > 2], "\n")
cat(xs[c(1, 3)], "\n")
cat(xs[c(TRUE, FALSE)], "\n")
cat(ys[ys > 1], "\n")
cat(length(xs[xs > 2]), "\n")
cat(sum(xs[xs %% 2 == 1]), "\n")
cat(c(TRUE, FALSE, TRUE), "\n")
cat(sum(c(TRUE, TRUE, FALSE)), "\n")
