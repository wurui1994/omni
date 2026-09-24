# ext/r/examples/glob.R —— 顶层的名字被函数看见（模块级变量）+ 形参在函数体里变宽
#
# 这一份跟 `stats.R` 一样是"照人真的会写的样子写一段"，压的是**名字的作用域**那一层：
# R 的函数看得见顶层的名字（`memo` 在 `fibm` 里直接用），而这一档的 `.sx` 里函数与 `main`
# 是平级的两段 —— 所以顶层那些"被函数自由用到"的名字要落成 `(global …)`，不能落成
# `main` 里的 `let`。
#
# 这一份找出来的几格真错（都已修）：
#   * `memo[n]` 在函数里 —— 那时 `memo` 既不是形参也不是局部量，从前推不出"装什么"。
#     现在顶层那份类型先定住，函数体推断时能问到（见 `globalTys`）。
#   * `collatz_len(n)` 的 `n` 从调用点看是 int，可函数体里 `n <- n / 2` 把它写成了 real ——
#     形参要跟着函数体一起变宽，再喂回调用点那一侧。
#   * `for (i in seq_along(items))` 的 `i` 是 double（在向量上遍历），拿它当下标时
#     地址那侧要 int —— 减一之后补 `toint`。
#   * "函数体里出现过的名字"不等于"自由的名字"：`sieve` 里的 `i`、`out` 是它自己的局部量，
#     跟顶层同名的 `i` 没关系。按"出现过"算的话，顶层的 `i` 会被当成模块级变量。

# 斐波那契记忆化：`memo` 是顶层的，`fibm` 读它也写它
memo <- numeric(40)
fibm <- function(n) {
  if (n <= 2) return(1)
  if (memo[n] > 0) return(memo[n])
  v <- fibm(n - 1) + fibm(n - 2)
  memo[n] <- v
  v
}
cat("fib(30) =", fibm(30), "\n")

# 考拉兹：`n` 从调用点是 int，函数体里 `n / 2` 把它变宽成 real
collatz_len <- function(n) {
  k <- 0
  while (n != 1) {
    if (n %% 2 == 0) n <- n / 2 else n <- 3 * n + 1
    k <- k + 1
  }
  k
}
best <- 0
bestn <- 0
for (i in 1:1000) {
  L <- collatz_len(i)
  if (L > best) {
    best <- L
    bestn <- i
  }
}
cat(sprintf("longest collatz under 1000: n=%d len=%d\n", bestn, best))

# 报表：左右对齐（字符向量还没有，所以名字用 sprintf 拼）
items <- c(1.5, 22.25, 333)
for (i in seq_along(items)) {
  cat(sprintf("%-5s %8.2f\n", sprintf("#%d", i), items[i]))
}

# repeat + next/break，循环量跟上面那个 `i` 同名（它们是同一格顶层的 `i`）
i <- 0
repeat {
  i <- i + 1
  if (i %% 3 != 0) next
  if (i > 10) break
  cat("mult3:", i, "\n")
}

# 位数与逆序：`n` 又是一格"从调用点是 int、函数体里变宽"的形参
revnum <- function(n) {
  out <- 0
  while (n > 0) {
    out <- out * 10 + n %% 10
    n <- n %/% 10
  }
  out
}
cat(revnum(123456), "\n")
cat(nchar(as.character(2^31)), "\n")
