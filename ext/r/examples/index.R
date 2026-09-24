# ext/r/examples/index.R —— 与 lua / go / V / nim / chez 那几份 index 同一件事
#
# 期望输出逐行相同：10 / 30 / 45。
# R 这一份压的是这一族里**唯一**的那条差别：**下标从 1 起**。`xs[1]` 落的是
# `aget(xs, 0)`，字面量在 adapter 里当场折掉（不发 `1 - 1`）。
# `c(10, 20, 30)` 是造一格向量 —— 在这一批里它就是数组那一格（`new-list`）。

xs <- c(10, 20, 30)
cat(xs[1], "\n", sep = "")
cat(xs[3], "\n", sep = "")
xs[2] <- 5

total <- 0
for (i in 1:3) {
  total <- total + xs[i]
}
cat(total, "\n", sep = "")
