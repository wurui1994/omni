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

# 零长那一格（R 印类型名）
print(diff(c(1)))
print(head(xs, 0))
