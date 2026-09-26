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

# 一元 `-` 与 R 的那一族数学函数在向量上逐元素（第一格实参是向量就映一趟）
cat(-xs, "\n")
cat(sqrt(c(1, 4, 9)), "\n")
cat(abs(c(-1, 2, -3)), "\n")
cat(exp(c(0, 1)), "\n")
cat(floor(c(1.7, -1.7)), "\n")
cat(round(c(1.234, 5.678), 1), "\n")
cat(signif(c(123456, 0.001234), 3), "\n")

# 进出都是向量的那三格
cat(rev(xs), "\n")
cat(seq_along(xs), "\n")
cat(which(xs > 2), "\n")
cat(which(ys > 1), "\n")
cat(xs[rev(seq_along(xs))], "\n")

# **负下标**：R 的 `x[-1]` 是"把第一格丢掉"，出来是一条向量。判正负是**运行期**的事
# （`x[c(-1,-2)]` 与 `x[-c(1,3)]` 在树上不同形），所以那三条规矩都在 `r_vec_pick` 里：
# 全是正数按位置挑、**下标 0 跳过**、全是负数丢掉那几格（越界的负下标不算）、正负混着当场停。
w <- c(10, 20, 30, 40)
print(w[-1])
print(w[-c(1, 3)])
print(w[-(1:2)])
print(w[c(-1, -2)])
print(w[-4])
print(w[-5])
print(w[-(1:4)])
print(w[c(1, 0, 2)])
k <- 2
print(w[-k])
cat(length(w[-1]), "\n")
zz <- c(TRUE, FALSE, TRUE)
print(zz[-1])

# **越界写就接长**（R：空档是 `NA`）。接长要换一格指针，所以只在左边是一个名字时接 ——
# 而 R 的赋值本来就是值语义，换指针没人看得见。名字那一条跟着长，新格是空串。
ex <- c(1, 2)
ex[5] <- 9
print(ex)
cat(length(ex), "\n")
ex[3] <- 7
print(ex)
ex[6] <- 0
print(ex)
ex2 <- c(1)
ex2[2] <- 2
ex2[4] <- 4
print(ex2)
cat(sum(ex2, na.rm = TRUE), "\n")
j <- 7
ex2[j] <- 70
print(ex2)
enm <- c(a = 1, b = 2)
enm[4] <- 40
print(enm)
print(names(enm))

# **读越界**那一档：R 回 `NA`（2026-09-26 接了 —— 从前是运行期撞
# `pointer out of bounds`，而且 `print` 的前半行已经印出去了）。`v[0]` 更糟：长度就存在
# 第 0 格的头上，`0 - 1 = -1` 正好读到它，于是 `c(1,4,9)[0]` **静默印出 3**
# （R 印 `numeric(0)`）。现在写着 0 的那一档编译期就报、运行期才知道是 0 的当场停下来。
rd <- c(1, 4, 9)
print(rd[2])
print(rd[5])
print(rd[c(1, 5, 2)])   # 下标向量里越界那几格也是 NA
print(rd[c(5, 6)])
kk <- 5
print(rd[kk])           # 运行期才知道的下标，同一条
cat(rd[1] + rd[3], "\n")
print(rd[-1])           # 写着负号那一档是"丢掉那一格"
print(rd[integer(0)])   # 零长下标 → 零长

# **`v[下标向量] <- 值` 与 `v[掩码] <- 值`**（2026-09-26 接的）。读那一侧早就有了，
# 写那一侧从前照发一格**标量**下标 —— `(let r_ix int 一条向量)` 一路发到 `.sx` 才撞上
# "是 int，初值是 real*"，而那时已经过了换档那道门：退出码 1、什么都不印、libR 也接不着。
# 量出来的口径全在 `r_wset` / `r_wmask` 的注里。下标里有缺失那一格分两种：
# 右边长度 1 就**跳过**那一格，右边长过 1 就**报错**（R 也是这么分的）。
wv <- c(1, 2, 3); wv[c(1, 3)] <- 0; print(wv)
wv <- c(1, 2, 3); wv[c(1, 3)] <- c(9, 8); print(wv)
wv <- c(1, 2, 3); wv[c(2, 2)] <- c(8, 9); print(wv)
wv <- c(1, 2, 3); wv[c(0, 2)] <- 5; print(wv)
wv <- c(1, 2, 3); wv[integer(0)] <- 9; print(wv)
wv <- c(1, 2); wv[c(1, 5)] <- 7; print(wv)
wv <- c(1, 2, 3); wv[wv > 1] <- 0; print(wv)
wv <- c(1, 2, 3); wv[wv > 1] <- c(7, 8); print(wv)
wv <- c(1, 2, 3); wv[c(TRUE, FALSE)] <- 0; print(wv)
wv <- c(1, 2); wv[c(TRUE, TRUE, TRUE)] <- 9; print(wv)
wv <- c(1, 2, 3, 4); wv[wv %% 2 == 0] <- -1; print(wv)
wv <- c(5, 3, 8); wv[which(wv > 4)] <- 0; print(wv)
wv <- c(1, 2, 3); wv[1:2] <- c(10, 20); print(wv)
wv <- c(1, 2, 3); wv[c(TRUE, NA, FALSE)] <- 9; print(wv)
wv <- c(1, 2, 3); wv[c(1, NA)] <- 9; print(wv)
wix <- c(1, 3)
wv <- c(1, 2, 3)
wv[wix] <- 0
cat(wv, sum(wv), length(wv), "\n")
