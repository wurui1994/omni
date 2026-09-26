# ext/r/examples/stats.R —— **一整段像真的 R**（不是逐格试语法，是端到端跑一遍）
#
# 前面那几份例子是"一格一格钉语义"的；这一份反过来 —— 照着人真的会写的样子写一段：
# 蒙特卡洛、描述统计、直方图计数、最小二乘回归、牛顿法、埃氏筛。它压的是**互相配合**
# 那一层：随机数 + 向量化 + `numeric(n)` 攒结果 + `sprintf` 排版 + 函数默认值 + 逻辑下标。
#
# 这一份找出来的两格真错（都已修）：
#   * `sort(z)[250]` —— 被下标的那格不是名字而是**一次调用**，从前推成 int，于是
#     `round(…)` 那儿报"(toreal E) 的参数要是 int"。类型那一问现在按表达式问。
#   * `out <- c()` —— R 里是 `NULL`，这一档落成**零长向量**；`out <- c(out, i)` 那种攒法
#     两者同解。
set.seed(2024)
n <- 20000
x <- runif(n)
y <- runif(n)
inside <- (x^2 + y^2) <= 1
cat("pi approx:", round(4 * sum(inside) / n, 4), "\n")

# 描述统计
z <- rnorm(500, 10, 2)
cat("n =", length(z), "\n")
cat("mean =", round(mean(z), 4), "\n")
cat("sd =", round(sd(z), 4), "\n")
cat("median-ish =", round(sort(z)[250], 4), "\n")
q <- sort(z)
cat("range =", round(range(z), 3), "\n")
cat("IQR-ish =", round(q[375] - q[125], 3), "\n")

# 直方图（计数）
brk <- seq(4, 16, by = 2)
counts <- numeric(length(brk) - 1)
for (i in 1:(length(brk) - 1)) {
  counts[i] <- sum(z > brk[i] & z <= brk[i + 1])
}
cat("counts:", counts, "\n")

# 累积
cat("cum:", cumsum(counts), "\n")

# 线性回归（最小二乘，手算）与残差
set.seed(7)
n <- 100
x <- runif(n, 0, 10)
noise <- rnorm(n, 0, 1.5)
y <- 2.5 * x + 1.2 + noise

sxx <- sum((x - mean(x))^2)
sxy <- sum((x - mean(x)) * (y - mean(y)))
b1 <- sxy / sxx
b0 <- mean(y) - b1 * mean(x)
cat(sprintf("y = %.4f + %.4f x\n", b0, b1))

fit <- b0 + b1 * x
res <- y - fit
cat(sprintf("RSS = %.4f\n", sum(res^2)))
cat(sprintf("R^2 = %.4f\n", 1 - sum(res^2) / sum((y - mean(y))^2)))

# 牛顿法求根
f <- function(t) t^3 - 2 * t - 5
fp <- function(t) 3 * t^2 - 2
newton <- function(t0, iters = 20) {
  t <- t0
  for (i in 1:iters) t <- t - f(t) / fp(t)
  t
}
cat(sprintf("root = %.10f\n", newton(2)))

# 素数（埃氏筛）
sieve <- function(m) {
  ok <- logical(m + 1)
  out <- c()
  for (i in 2:m) {
    if (!ok[i]) {
      out <- c(out, i)
      j <- i * i
      while (j <= m) {
        ok[j] <- TRUE
        j <- j + i
      }
    }
  }
  out
}
p <- sieve(50)
cat("primes:", p, "\n")
cat("how many:", length(p), "\n")

# **`quantile(xs)` 不给 `probs` 那一档名字接住了**：R 的五个标签
# `0% 25% 50% 75% 100%` 是**编译期常量**，所以名字那一条走影子变量那条路
# （合成一格 `c("0%", …)` 再发一遍），不用让 `r_quantile` 交出"值 + 名字"两样东西。
# 给了 `probs` 的还是要明写 `names = FALSE` —— 那几个标签要照 R 的
# `formatC(100*probs, format = "fg", width = 1, digits = 7)` 排，那是另一刀。
qxs <- c(12.5, 3, 47, 8.25, 19, 3, 47, 0.5)
qq <- quantile(qxs)
print(qq)
cat(qq, "\n")
cat(names(qq), "\n")
# `qq[[2]]` 在 R 里对原子向量也合法 —— 从前 `dictNames` 一看见 `[[…]]` 就把 `qq`
# 当成一张表，于是名字那一条跟着就报。现在"一望而知造向量"的那几格调用
# （`VEC_MAKERS`）把名字从那张表里摘出来。
cat(qq[[2]], qq["50%"], qq[[4]] - qq[[2]], "\n")
print(quantile(c(1, 2, 3, 4)))
print(quantile(qxs, names = FALSE))
print(quantile(qxs, probs = c(0, 0.5, 1), names = FALSE))
print(quantile(c(5)))
print(round(quantile(qxs), 2))
## 给了 probs 那一档的标签：formatC(100*probs, format = "fg", width = 1, digits = 7) + "%"
qsx <- c(1, 2, 3, 4)
print(quantile(qsx, 0.5))
print(quantile(qsx, c(0.25, 0.75)))
print(quantile(qsx, 1 / 3))
print(quantile(qsx, c(0, 1)))
print(quantile(qsx, 0.125))
print(quantile(qsx, 2 / 3))
print(names(quantile(qsx, c(0.25, 0.75))))
cat(quantile(qsx, 0.5), names(quantile(qsx, 0.5)), "\n")
