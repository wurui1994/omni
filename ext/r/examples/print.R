# ext/r/examples/print.R —— `print()` 与顶层的自动印
#
# `cat` 与 `print` 是两件事。`cat` 把值连成文本（不带换行、不带标号、串不带引号），
# `print` 印的是"这个对象长什么样"：行首 `[k]` 标号、**一整条向量共用一套宽度**、
# 到 80 列换行、串带引号。
#
# 共用宽度这件事是 R 的 `formatReal`：先把每格的"小数点左边几位 / 有效数字几位"取极值，
# **挑一次**定点还是科学记数，然后每格按同一套 `(宽, 小数位, 要不要科学记数)` 右对齐。
# 于是同一条向量里不会有一格定点一格科学记数：
#
#   c(1.5, 22.25, 333)  →  `  1.50  22.25 333.00`（共用 6 格宽、2 位小数）
#   c(0.001, 1000)      →  `1e-03 1e+03`（定点要 8 格、科学记数只要 5 格）
#
# 标号也是对齐的：宽度按**最后一个**标号算，所以 25 格的向量行首是 ` [1]`（前面空一格）。
#
# 顶层的**自动印**：R 在顶层对"可见的"值自动调 `print`，所以 `x` 单独一行会印出来。
# 赋值、`for` / `while`、`cat()`、`invisible()` 都不可见。这一档只对认得出类型的那几种
# 自动印（字面量 / 名字 / 下标 / 算式 / `BUILTINS` 里的内建）—— 用户函数的调用刻意不印，
# 见 SPEC 第四节第 5 条。

print(3.14159265)
print(1e5)
print(42)
print(TRUE)
print("hi")

# 一整条向量共用一套宽度
print(c(1, 2, 3))
print(c(1.5, 22.25, 333))
print(c(0.001, 1000))
print(c(1e-10, 1))
print(c(-1, 2.5))
print(c(0.1, 0.12, 0.123, 0.1234))

# 三格非有限值各占多宽（`NA` 2 格、`NaN` 与 `Inf` 3 格、`-Inf` 4 格）
print(c(1, NA, 3))
print(c(-1.5, NA, Inf, -Inf, NaN))

# 逻辑向量：宽度是 `FALSE` 那 5 格
print(c(TRUE, FALSE, NA))

# 换行与标号对齐
print(1:25)
print(1:100)
print((1:60) / 2)
print(sqrt(1:10))
print((1:12) * 1000)

# 顶层自动印
x <- c(2.5, 3.5)
x
2 + 2
"str"
x > 3
!(x > 3)
any(x > 3)
x[1]
length(x)
sum(x)
rev(x)
paste("a", "b")

# 这两格不可见（印不出东西来）
invisible(5)
y <- 7

# 零长向量印的是**元素类型名**，不是一律 `numeric(0)`：位置那一族（`which` / `seq_len` /
# `seq_along` / `order` / `match` / `nchar` / `integer(n)` / `1:n`）在 R 里是**整数**向量，
# `cumsum` / `diff` / `sort` / `rev` / `head` / 三格集合运算跟着进去的那条走。
# 存法这一侧两者一样（都是 `(ptr real)`），差的就是这一行字 —— 见 adapter 的 `RIVEC`。
print(which(x > 100))
print(seq_len(0))
print(seq_along(character(0)))
print(order(numeric(0)))
print(nchar(character(0)))
print(integer(0))
print(numeric(0))
print(character(0))
print(logical(0))
print(diff(1:1))
print(cumsum(integer(0)))
print(unique(integer(0)))
print(sort(integer(0)))
print(rev(integer(0)))
print(head(1:3, 0))
print(intersect(1:2, 3:4))
print(setdiff(1:2, 1:2))
print(match(integer(0), 1:2))

# **`cat` 的 sep 里带换行的话，末尾还要多一个 `"\n"`** —— 那不是"元素之间的分隔"，
# 是 `do_cat` 收尾处单独一句（src/main/builtin.c 里的 `nlsep`）。所以 sep = "\n" 带
# 末尾那一格、sep = ", " 不带。从前这儿少一个字节，后面每一行都往上顶一格。
catw <- c("alpha", "beta", "GAMMA")
cat(sprintf("%s:%d", catw, nchar(catw)), sep = "\n")
cat("AFTER\n")
cat(catw, sep = "\n")
cat("AFTER2\n")
cat(catw, sep = ", ")
cat("AFTER3\n")
cat("a", "b", sep = "\n")
cat("AFTER4\n")
cat(1:3, sep = "\n")
cat("AFTER5\n")
cat(c(TRUE, FALSE), sep = "\n")
cat("AFTER6\n")
cat(catw, sep = "")
cat("AFTER7\n")
cat(character(0), sep = "\n")
cat("AFTER8\n")
cat(3.5, sep = "\n")
cat("AFTER9\n")
