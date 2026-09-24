# ext/r/examples/numstr.R —— 与 ext/nim/examples/numstr.nim 同一件事
#
# 期望输出逐行相同：n=7 / i=42。
# 数变成串：nim 要显式的 `$`，R 的 `paste0` 自己就会转（`as.character` 的那一格语义）——
# 两格节点、一份输出。adapter 在串接的每一格上按类型补 `tostr`。

n <- 7
cat(paste0("n=", n), "\n", sep = "")
i <- 42L
cat(paste0("i=", i), "\n", sep = "")
