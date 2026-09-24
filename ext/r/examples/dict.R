# ext/r/examples/dict.R —— 与 go / V / awk / nim / lua / chez 那几份 dict 同一件事
#
# 期望输出逐行相同：1 / 3 / 4 / yes。
# R 的写法与别的门都不一样：**`list` 带名字用就是关联表**，取写靠 `[[…]]`，
# 而"有没有这个键"没有专门的算子 —— R 的惯用写法是 `!is.null(m[["a"]])`
# （缺键回 `NULL`）。adapter 只认这一种形状，落 `dhas`；别的 `is.null` 当场报。
#
# 键是**值**（这儿是串常量），不是名字 —— 那正是 map 与 record 分成两族的理由。

m <- list()
m[["a"]] <- 1
m[["b"]] <- 3
cat(m[["a"]], "\n", sep = "")
cat(m[["b"]], "\n", sep = "")
m[["c"]] <- 4
cat(m[["c"]], "\n", sep = "")
if (!is.null(m[["a"]])) {
  cat("yes", "\n", sep = "")
}
