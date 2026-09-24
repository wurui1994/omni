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
