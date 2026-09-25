# ext/r/examples/vecfn.R —— base 里那一族向量函数，与三态逻辑的那几个
#
# 每一格的**缺失口径都是 R 定的、各不相同**，这是这份例子真正要钉住的东西：
#
#   sort(c(3, NA, 1))   `1 3`      —— 丢掉（`na.last = NA` 是默认）
#   max(c(1, NA))       `NA`       —— 传下去（按 `>` 比是躲不过去的：`NaN > x` 恒假，
#                                     所以这一格必须每元素先问一句 `is.na`）
#   range(c(1, NA, 3))  `NA NA`    —— 两头都成缺失
#   cumsum(c(1, NA, 3)) `1 NA NA`  —— 按浮点自然传播
#   ifelse(NA, 1, 2)    `NA`       —— 判断缺失就交缺失
#   isTRUE(NA)          `FALSE`    —— 这一格**不是**三态（R 的文档：只认"长度 1 的真"）
#
# `sort` 用的是 Shell 排序（Knuth 的 gap 序列）。R 自己用快排/基数排序，但"全排序"的
# 结果是唯一的 —— double 上相等的元素分不出来，所以哪种算法都逐字节一致。

xs <- c(3, 1, 4, 1, 5, 9, 2, 6)

print(sort(xs))
print(rev(sort(xs)))
print(cumsum(xs))
print(diff(xs))
print(range(xs))
print(prod(c(1, 2, 3, 4)))
print(var(xs))
print(sd(xs))

# 取前几格 / 后几格（缺省 6；负数是"去掉那么多格"）
print(head(xs))
print(head(xs, 3))
print(tail(xs, 2))
print(head(xs, -6))
print(tail(xs, -6))

# 造向量：`rep` 两档、`seq` 两档
print(rep(0, 4))
print(rep(c(1, 2), 3))
print(seq(1, 10))
print(seq(1, 10, 3))
print(seq(0, 1, by = 0.25))

# 缺失那几格各自的口径
print(sort(c(3, NA, 1)))
print(max(c(1, NA, 3)))
print(min(c(1, NA, 3)))
print(range(c(1, NA, 3)))
print(cumsum(c(1, NA, 3)))
print(sum(c(1, NA, 3)))

# 三态逻辑的那几个函数
a <- 1.5
print(xor(a > 1, a > 2))
print(xor(a > 1, a > 0))
print(xor(NA > 1, a > 2))
print(isTRUE(a > 1))
print(isTRUE(NA > 1))
print(isFALSE(a > 2))
print(isFALSE(NA > 1))
print(ifelse(a > 1, 10, 20))
print(ifelse(NA > 2, 10, 20))
print(ifelse(xs > 3, 0, 1))
print(ifelse(c(1, NA, 3) > 2, 100, 200))
print(xor(xs > 3, xs > 4))

# 排完还是逻辑向量（元素类型跟着进去的那条走）
print(sort(c(TRUE, FALSE, TRUE)))
print(head(c(TRUE, FALSE, NA), 2))
print(rep(c(TRUE, FALSE), 2))

# `na.rm = TRUE` —— "把缺失当不存在"。落法是**先滤一遍再算**（`r_drop_na`）：这一句
# 与"每个函数里各自跳过"同解，`mean` 的分母也跟着变小。
# 这一格从前是**静默丢掉**那个命名实参的 —— `sum(x, na.rm = TRUE)` 答 `NA` 而 R 答 4。
# 所以现在认不出来的命名实参一律当场报（`NAMED_OK` 那张白名单）；连 `sort(x, na.rm=TRUE)`
# 也报 —— R 自己都说"参数没有用(na.rm = TRUE)"。
ys <- c(1, NA, 3, 10)
print(sum(ys, na.rm = TRUE))
print(mean(ys, na.rm = TRUE))
print(max(ys, na.rm = TRUE))
print(min(ys, na.rm = TRUE))
print(prod(ys, na.rm = TRUE))
print(range(ys, na.rm = TRUE))
print(round(sd(ys, na.rm = TRUE), 6))
print(round(var(ys, na.rm = TRUE), 6))
print(sum(ys, na.rm = FALSE))
print(any(c(TRUE, NA, FALSE), na.rm = TRUE))
print(all(c(TRUE, NA, FALSE), na.rm = TRUE))

# `seq_len(n)` 当**值**用（`for` 头上那一档在 `forOf` 里落成计数循环，不造向量）
print(seq_len(4))
cat(length(seq_len(0)), "\n")

# 零长那一格（R 印类型名）
print(diff(c(1)))
print(head(xs, 0))

# **任意多格实参**：`max` / `min` / `sum` / `prod` / `range` 把那几格先摊平成一条向量
# （与 `c(…)` 同一段代码），再走单实参那一格 —— 于是缺失那条规矩只有一份实现。
# R 的口径是"有 `NA` 就是 `NA`、只有 `NaN` 才是 `NaN`"（`max(NaN, NA)` 也是 `NA`）。
cat(max(1, 5, 3), min(2, 1, 7), "\n")
cat(max(c(1, 2), 5), min(c(4, 9), 2), "\n")
cat(sum(1, 2, 3), sum(c(1, 2), c(3, 4), 10), "\n")
cat(prod(2, 3, 4), "\n")
print(range(1, 5, 3))
cat(max(1, NA), max(1, NA, na.rm = TRUE), "\n")
cat(max(1, NaN), max(NA, NaN), max(NaN, NA), "\n")
# 一格标量也收（R 的 `sum(5)` 就是 5）
cat(sum(5), max(5), mean(5), "\n")
# `mean(1, 2)` 在 R 里答的是 1（第二格是 trim=）—— 这一层不假装，当场报

# `sort(x, decreasing = TRUE)` —— 升着排完倒过来（相等的那几格分不出来，所以与 R 一样）
print(sort(xs, decreasing = TRUE))
print(sort(c(2, NA, 1), decreasing = TRUE))

# `rep` 的三格与 `seq` 的 `length.out=`
# R 的次序是**先 each 再 times**（`rep(c(1,2), times=2, each=3)` 是 `1 1 1 2 2 2 1 1 1 2 2 2`）
print(rep(c(1, 2), each = 2))
print(rep(c(1, 2), times = 2, each = 3))
print(rep(5, 3))
print(rep(c(1, 2), 0))
# `seq(a, b, length.out = k)`：步长 `(b-a)/(k-1)`，**最后一格写成 b**（R 的 C 也是这个口径）
print(seq(1, 10, length.out = 4))
print(seq(0, 1, length.out = 3))
print(seq(2, 2, length.out = 3))
print(seq(1, 10, length.out = 1))
# `seq(n)` 就是 `1:n`
print(seq(5))
