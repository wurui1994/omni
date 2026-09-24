# ext/r/examples/intmath.R —— 与 lua / go / V / nim / mojo / awk 那几份 intmath 同一件事
#
# 期望输出逐行相同：15 / 120。
# 与 basics 的差别只有"少了两行"——留着它是因为这一族是**最小的那把尺子**：
# 循环 + 递归 + 隐式返回，一格都不多。

sumto <- function(n) {
  acc <- 0
  for (i in 1:n) acc <- acc + i
  acc
}

fact <- function(n) {
  if (n == 0) return(1)
  n * fact(n - 1)
}

cat(sumto(5), "\n", sep = "")
cat(fact(5), "\n", sep = "")
