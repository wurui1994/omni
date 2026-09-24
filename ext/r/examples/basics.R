# ext/r/examples/basics.R —— 与别的十一门那几份 basics **同一件事**
#
# 期望输出逐行相同：15 / 120 / 7 / ok（判据在 tests/lower/run.js），
# 而且这一份**逐字节对 Rscript**（tests/r/oracle.js）—— 本机有真 R，期望值不是我们编的。
#
# R 这一份压的是别的语言压不到的三样：
#   * **函数是值**：`sumto <- function(n) …` 是一格赋值，不是声明（adapter 顶层提升）
#   * **最后一句就是返回值**：`acc` 那一行没有 `return`
#   * **`return()` 是一次调用**：`fact` 里那一句在树上是 `(call (sym return) …)`
#
# `cat(…, sep = "")` 不是凑数：R 的 `cat` 默认用空格连实参，要逐字节对上就得说 sep=""。

sumto <- function(n) {
  acc <- 0
  for (i in 1:n) {
    acc <- acc + i
  }
  acc
}

fact <- function(n) {
  if (n == 0) {
    return(1)
  }
  n * fact(n - 1)
}

max2 <- function(a, b) {
  if (a > b) a else b
}

cat(sumto(5), "\n", sep = "")
cat(fact(5), "\n", sep = "")
cat(max2(3, 7), "\n", sep = "")
tag <- "ok"
cat(tag, "\n", sep = "")
