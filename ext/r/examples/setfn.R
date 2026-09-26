# ext/r/examples/setfn.R —— 集合与位置那一族（`match` / `%in%` / `unique` / `order`…）
#
# 这一族真正难的只有两问，而且都是 R 自己的规矩：
#
#   1. **"两格值算不算同一格"** —— `NA` 与 `NA` 算同一格（`NA %in% c(1, NA)` 是 TRUE、
#      `unique(c(NA, NA))` 只剩一格），`NaN` 与 `NaN` 也算，而 `NA` 与 `NaN` **不算**。
#      按 `==` 比这三问全是假（浮点的规矩），所以单独落成一个函数（`r_same`）。
#   2. **`order` 的次序** —— 缺失摆最后，同值按原来的先后（稳定）。这儿的比较把"原下标"
#      当最后一把钥匙，于是那个次序是**唯一的** —— 用哪种排序算法都得到 R 那一条，
#      不必真写一个稳定排序。
#
# `pmax` / `pmin` 是**两头回收**的（R 的 `max(a, b)` 才是"任意多格实参"那一层）。

x <- c(3, 1, 4, 1, 5)

# 位置
cat(which.max(x), which.min(x), "\n")
print(order(x))
print(x[order(x)])
print(order(c(2, 1, 2, 1)))     # 同值按原来的先后
print(match(c(4, 9), x))        # 找不到是 NA

# 在不在里头
cat(4 %in% x, 9 %in% x, "\n")
if (4 %in% x) cat("4 在里头\n")
print(x %in% c(1, 5))

# 去重与集合
print(unique(c(1, 2, 2, 3, 1)))
print(duplicated(c(1, 2, 2, 1)))
print(union(c(1, 2), c(2, 3)))
print(intersect(c(1, 2, 3), c(2, 3, 4)))
print(setdiff(c(1, 2, 3), c(2)))

# 逐元素两头取大取小（回收；有一边缺失就交缺失）
print(pmax(c(1, 5, 2), c(3, 2, 2)))
print(pmin(c(1, 5), 3))
print(pmax(c(1, NA), c(0, 5)))

# 累乘
print(cumprod(c(1, 2, 3, 4)))

# 缺失那几问
print(unique(c(1, NA, NA)))
print(match(NA, c(1, NA)))
cat(NA %in% c(1, NA), "\n")
print(order(c(3, NA, 1)))

# `is.element(el, set)` 与 `el %in% set` 是同一格（R 的文档就这么写的）
print(is.element(2, c(1, 2, 3)))
print(is.element(c(1, 5), c(1, 2, 3)))
print(is.element(c(NA, 2), c(1, 2)))
print(is.element(2, c(1, NA)))
# `setequal`：当集合看 —— 重复的那几格不算，`NA` 与 `NA` 算同一格
print(setequal(c(1, 2), c(2, 1)))
print(setequal(c(1, 2), c(1, 2, 3)))
print(setequal(c(1, 1, 2), c(2, 1)))
print(setequal(c(1, 2), c(3, 4)))
print(setequal(c(NA, 1), c(1, NA)))
# `findInterval(x, vec)`：有几格断点 `<= x`（比所有断点都小是 0，缺失回 NA）
print(findInterval(c(1.5, 2.5), c(1, 2, 3)))
print(findInterval(c(0.5, 3.5), c(1, 2, 3)))
print(findInterval(c(1, 2, 3), c(1, 2, 3)))
print(findInterval(c(2), c(1, 2, 2, 3)))
print(findInterval(c(NA, 2), c(1, 2)))
cat(findInterval(c(1.2, 9), c(1, 5)), "\n")

# `anyDuplicated(v)` —— 回**第一格重复元素的位置**（1 起），一格都没有回 0。
# 串那一侧也接（与 `duplicated` 同一条：只要"相等"）
print(anyDuplicated(c(1, 2, 1)))
print(anyDuplicated(c(1, 2, 3)))
print(anyDuplicated(c(5)))
print(anyDuplicated(c(1, 1)))
print(anyDuplicated(c(3, 1, 4, 1, 5)))
print(anyDuplicated(c(NA, 1, NA)))
print(anyDuplicated(c("b", "a", "b")))
print(anyDuplicated(c("a", "b")))
cat(anyDuplicated(c(2, 2)), anyDuplicated(c(2, 3)), "\n")

# **`order(x, decreasing = TRUE)`**：换一份比较（只有值那两格反过来）——
# 缺失照旧摆最后、同值照旧按**原下标**。量出来 R 就是这样：
# `order(c(2,1,2,1), decreasing=TRUE)` 是 `1 3 2 4`，不是"升着排完倒过来"的 `3 1 4 2`。
cat(order(c(3, 1, 2), decreasing = TRUE), "\n")
cat(order(c(2, 1, 2, 1), decreasing = TRUE), "\n")
cat(order(c(3, NA, 1), decreasing = TRUE), "\n")
cat(order(c(5, 5, 5), decreasing = TRUE), "\n")
cat(order(c(3, 1, 4, 1, 5), decreasing = TRUE), "\n")
cat(order(c(3, 1, 4, 1, 5), decreasing = FALSE), "\n")
odv <- c(10, 30, 20)
cat(odv[order(odv, decreasing = TRUE)], "\n")
cat(order(numeric(0), decreasing = TRUE), "\n")
print(order(c(1.5, -2.5, 0), decreasing = TRUE))

# **`rep(x, length.out = n)`** 单独用那一档就是 `rep_len(x, n)`（那一格本来就有）。
# 与 `times` / `each` 一起用还没接 —— 三格叠起来的次序没量过，所以当场报。
cat(rep(c(1, 2), length.out = 5), "\n")
cat(rep(c(1, 2, 3), length.out = 2), "\n")
cat(rep(7, length.out = 4), "\n")
cat(rep(c(1, 2), length.out = 0), "\n")
odn <- 3
cat(rep(c(9, 8), length.out = odn), "\n")
print(rep(c(1, 2), length.out = 5))
