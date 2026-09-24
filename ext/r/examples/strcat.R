# ext/r/examples/strcat.R —— 与 nim / V 那两份 strcat 同一件事
#
# 期望输出逐行相同：ab / hi there。
# 记号差得远、节点相同：nim 写 `&`、V 与 go 写 `+`、lua 写 `..`，R 写**两个函数**——
# `paste0` 不加分隔、`paste` 默认加一个空格。**内建不是调用**：它们落成串接那一格。

a <- "a"
b <- "b"
cat(paste0(a, b), "\n", sep = "")
cat(paste("hi", "there"), "\n", sep = "")
