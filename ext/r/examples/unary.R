# ext/r/examples/unary.R —— 与 ext/lua/examples/unary.lua 与 awk 那两份同一件事
#
# 期望输出逐行相同：-5 / 1 / 3。
# 第三行各门写法不同、节点相同：lua 写 `#s`、awk 写 `length(s)`、R 写 `nchar(s)`，
# 都落 `slen`。**R 的 `length(s)` 不是串长**（那是"这个向量有几个元素"，对一格串回 1）——
# 这一格是 R 独有的坑，adapter 按类型分：串上是 `slen`、表上是 `dlen`、别的是 `alen`。

neg <- function(n) {
  -n
}

x <- 5
cat(neg(x), "\n", sep = "")
if (!(x > 9)) {
  cat(1, "\n", sep = "")
} else {
  cat(0, "\n", sep = "")
}
s <- "abc"
cat(nchar(s), "\n", sep = "")
