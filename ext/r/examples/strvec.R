# ext/r/examples/strvec.R —— 字符向量（`c("a", "bb")` 那一条）
#
# 前面那些例子里的"串"都是**一格**串（`paste` / `substr` / `sprintf`）。这一份立的是
# **一条装串的向量**：造、取、写、长度、`cat`、`print`、`for … in`、`paste(collapse=)`、
# `rev`、`seq_along`，以及"混着数写 `c()` 时 R 会把整条收成字符向量"那一条。
#
# 存法与数值向量**不一样**：数值向量是 `(ptr real)` + 槽 0 装长度（为了 `NA` 那个 NaN
# 载荷），字符向量是方言的 `(arr string)` —— 自带长度、`apush` 还能现长，于是
# `out <- c(out, s)` 那种攒法不必先算总长。账在 `ext/r/adapter.js` 的 `RSTRV` 那一段。
#
# `print` 的两处与数值不同（都是 R 自己的规矩，量出来的）：元素**带引号**、
# 宽度按"最长那格 + 两个引号"取、而且**左对齐** —— 所以 R 印出来的行尾真的有空格。

labels <- c("a", "bb", "ccc")
print(labels)
cat(labels, "\n")
cat(labels, sep = "|")
cat("\n")
cat("第二格:", labels[2], "长度:", length(labels), "\n")

# 遍历
for (s in labels) cat("<", s, ">\n")
for (i in seq_along(labels)) cat(i, labels[i], "\n")

# 80 列折行：最长那格 19 个字符 + 两个引号 = 21，一行摆得下三格
words <- c("alpha", "b", "gamma-delta-epsilon", "z")
print(words)

# 零长与"先开好再填"
print(character(0))
buf <- character(3)
buf[1] <- "x"
buf[3] <- "zzz"
print(buf)

# 攒结果：`c(out, 新的一格)`（R 里最常见的那种写法）
tag <- function(s, k) paste0("[", s, "#", k, "]")
collect <- function(n) {
  out <- c("start")
  for (i in 1:n) out <- c(out, tag("item", i))
  out
}
r <- collect(3)
print(r)
cat("攒了", length(r), "格\n")

# 当实参、当返回值、当顶层的名字（函数看得见它）
gl <- c("g1", "g2")
useg <- function(k) gl[k]
cat(useg(2), "\n")
first <- function(v) v[1]
cat(first(labels), "\n")
print(rev(labels))
cat(paste(labels, collapse = ", "), "\n")

# 混着数写：R 把整条收成字符向量，数按 `as.character` 的 15 位有效数字转
mixed <- c("n=", 3, 1 / 3)
print(mixed)
