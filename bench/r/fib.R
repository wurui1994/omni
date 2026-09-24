# bench/r/fib.R —— 递归调用：量的是函数调用那条路（R 的 closure + 环境 vs 我们的直接调用）
f <- function(n) {
  if (n < 2) return(n)
  f(n - 1) + f(n - 2)
}
cat(f(28), "\n")
