# ext/r/examples/loopexit.R —— 与 go / lua / V / nim / mojo / cpp / awk 那几份同一件事
#
# 期望输出逐行相同：12 / 6 / 8。
# 这一份压两样：
#   * **`repeat` 就是 `while (TRUE)`**（R 里它只能靠 `break` 出来）；R 的 `next` 是别人的
#     `continue`，落的是**同一格节点**（差的只有一格附属 kind）。
#   * **`next` 与步进的关系**：`for (j in 0:4)` 落成一格计数循环，步进摆在 `post` 端口上，
#     所以 `next` 跳过体的剩下部分却照跑步进（缀在体末尾的写法在这儿会死循环）。

s <- 0
i <- 0
repeat {
  i <- i + 1
  if (i > 5) break
  if (i == 3) next
  s <- s + i
}
cat(s, "\n", sep = "")
cat(i, "\n", sep = "")

t <- 0
for (j in 0:4) {
  if (j == 2) next
  t <- t + j
}
cat(t, "\n", sep = "")
