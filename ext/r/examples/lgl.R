# ext/r/examples/lgl.R —— R 的逻辑值是**三态**的
#
# `TRUE` / `FALSE` / `NA`。缺失这一格不是"某种假"：`NA > 2` 是 `NA`，
# `NaN > 2` 也是 `NA`（`is.na` 对这两格都真）。所以一格逻辑值装不进 C 的 bool ——
# 这一档把它存成 double 的 1.0 / 0.0 / NA，账在 `ext/r/adapter.js` 的 `RLGL1`。
#
# 三态的真值表有两格反直觉（`?Logic`）：
#   `NA & FALSE` 是 **FALSE**（不是 NA）—— 有一边是假，另一边是什么都不影响结果；
#   `NA | TRUE`  是 **TRUE**（同理）。
# 按"有 NA 就 NA"写会在这两格答错。
#
# `if (NA)` 在 R 里是一条**错误**（"missing value where TRUE/FALSE needed"），
# 不是当假 —— 这一档落成方言的 `(fail …)`（那条路不在这份例子里：Rscript 会退出 1，
# 而这一轴判的是"退出 0 且逐字节相同"）。

x <- 1.5

# 比较回三态
cat(x > 2, "\n", sep = "")
cat(x < 2, "\n", sep = "")
cat(NaN > 2, "\n", sep = "")
cat(NA > 2, "\n", sep = "")
cat(x == 1.5, "\n", sep = "")
cat(x != 1.5, "\n", sep = "")

# 取反与那两格反直觉的
cat(!(x > 2), "\n", sep = "")
cat(!(NA > 2), "\n", sep = "")
cat((NA > 2) & (x > 2), "\n", sep = "")
cat((NA > 2) & (x < 2), "\n", sep = "")
cat((NA > 2) | (x > 2), "\n", sep = "")
cat((NA > 2) | (x < 2), "\n", sep = "")

# `TRUE` / `FALSE` 那两个字面量混进来
cat(TRUE && (x < 2), "\n", sep = "")
cat(FALSE || (x > 2), "\n", sep = "")
cat(TRUE, "\n", sep = "")

# 逻辑向量：每一格各自三态
xs <- c(1, NA, 3)
zs <- xs > 2
cat(zs, "\n")
cat(length(zs), "\n", sep = "")

# 逻辑向量里取一格出来还是逻辑（不是 1 / 0）
cat(zs[1], "\n", sep = "")
cat(zs[2], "\n", sep = "")
cat(zs[3], "\n", sep = "")

# 逐元素的 `&` / `|` / `!`（回收规则照旧管）
ws <- xs < 3
cat(ws, "\n")
cat(zs & ws, "\n")
cat(zs | ws, "\n")
cat(!zs, "\n")
cat(zs & TRUE, "\n")
cat(zs | TRUE, "\n")

# `any` / `all` 回的是**一格三态标量**
cat(any(zs), "\n", sep = "")
cat(all(zs), "\n", sep = "")
cat(any(xs > 5), "\n", sep = "")
cat(all(xs > 0), "\n", sep = "")
cat(any(c(1, 2) > 1), "\n", sep = "")
cat(all(c(1, 2) > 0), "\n", sep = "")
cat(any(c(1, 2) > 5), "\n", sep = "")
cat(all(c(1, 2) > 1), "\n", sep = "")

# 逻辑当数用：TRUE 是 1（于是 `sum` 数个数，有 NA 就是 NA）
cat(sum(ws), "\n", sep = "")
cat(sum(zs), "\n", sep = "")
cat((x < 2) + 1, "\n", sep = "")

# 当条件用（非 NA 那一档照旧）
if (x < 2) cat("yes\n")
if (any(ws)) cat("some\n")
if (!all(zs)) cat("not all\n")

# 下标：逻辑向量当掩码（NA 挑出一格 NA，这是 R 的规矩）
cat(xs[ws], "\n")
cat(xs[!zs], "\n")
cat(which(ws), "\n")

# base 里那几个有名字的常量（`pi` / `T` / `F` 是变量，不是字面量）
cat(T, "\n", sep = "")
cat(F, "\n", sep = "")
cat(pi, "\n", sep = "")
cat(sin(pi / 2), "\n", sep = "")

# **逻辑当数用**：R 里 `TRUE` / `FALSE` 在算术与比较里就是 1 / 0。方言里 bool 上没有算术，
# 所以有一边是 bool 就先摊成 int（字面量当场折，别的落一格三元）。
cat(TRUE + TRUE, TRUE - FALSE, "\n")
cat(TRUE * 3, FALSE * 3, "\n")
cat((1 > 0) + (2 > 1), "\n")
cat(TRUE > FALSE, TRUE == TRUE, "\n")
cat(TRUE + 1.5, "\n")
b <- TRUE
cat(b + 1, "\n")
# 数一数"有几格满足" —— R 里这是常用写法
n <- 0
for (k in c(1, 5, 3)) n <- n + (k > 2)
cat(n, "\n")
