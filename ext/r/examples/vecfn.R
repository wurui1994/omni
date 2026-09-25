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

# `cummax` / `cummin`：**碰上缺失之后全是缺失**（与 `NaN` 比出来的都是假，所以不能只写
# `if (x > acc)` —— 那样 `cummax(c(1,NA,3))` 会印 `1 1 3`，而 R 是 `1 NA NA`）。
print(cummax(c(1, 3, 2, 5, 4)))
print(cummin(c(5, 3, 4, 1, 2)))
print(cummax(c(1, NA, 3)))
print(cummin(c(2, NA, 1)))
print(cummax(c(-1.5, -2.5)))
print(cummin(c(-1.5, -2.5)))
cat(cummax(c(1, 3)), "\n")
cat(cummin(1:4), "\n")
# `rep_len(x, n)`：循环取到长度 n（短了从头再来、长了截掉）
print(rep_len(c(1, 2, 3), 7))
print(rep_len(c(1, 2, 3), 2))
print(rep_len(c(5), 3))
print(rep_len(7, 4))
cat(length(rep_len(c(1, 2), 5)), "\n")

# `tabulate(bin, nbins)`：数每一格 1..nbins 出现了几次。三种格子都不记 ——
# 缺失、`<= 0`、`> nbins`；值先朝零截（`2.7` 记进第 2 格）。
# 不给 `nbins` 时默认长度是 `as.integer(max(1, bin))` —— 所以 `c(2.7, 2.2, 1.9)` 只有两格
print(tabulate(c(2, 3, 3, 5, 1, 3)))
print(tabulate(c(2, 3, 3), nbins = 5))
print(tabulate(c(1, 2, 3), nbins = 2))
print(tabulate(c(0, -1, 4, 4)))
print(tabulate(c(1, NA, 2, 2)))
print(tabulate(c(2.7, 2.2, 1.9)))
print(tabulate(1:4))
cat(tabulate(c(1, 1, 3)), "\n")
cat(length(tabulate(c(3))), "\n")
print(tabulate(c(1, 2), nbins = 0))
# `anyNA(x)`：**`NaN` 也算**（R 的 `is.na(NaN)` 是 TRUE）
print(anyNA(c(1, 2, 3)))
print(anyNA(c(1, NA, 3)))
print(anyNA(c(NA)))
print(anyNA(3))
print(anyNA(c(1, NaN)))
# `append(x, values, after)`：插在第 `after` 格之后，不给就接到最后
print(append(c(1, 2), c(3, 4)))
print(append(c(1, 2, 3), c(9), after = 1))
print(append(c(1, 2, 3), c(9), after = 0))
print(append(c(1, 2, 3), c(8, 9), after = 3))
print(append(c(1, 2), 7))
# `replace(x, k, v)` 就是 `x[k] <- v`：`v` 短了循环取、`k` 超长就接长（空档 NA）、`k` 是 0 空动作
print(replace(c(1, 2, 3), 2, 9))
print(replace(c(1, 2, 3, 4), c(1, 3), c(7, 8)))
print(replace(c(1, 2, 3, 4), c(2, 3), 0))
print(replace(c(1, 2, 3), 1, NA))
print(replace(c(1, 2), 5, 9))
print(replace(c(1, 2), 0, 9))
cat(replace(c(5, 6), 2, 1), "\n")

# `median(x)`：排完取中间 —— 偶数格是中间两格的平均。缺失那一问在排之前问
# （`na.rm = FALSE` 是 `NA`，而排序那一格顺手把缺失丢了，排完就看不出来了）
print(median(c(3, 1, 2)))
print(median(c(1, 2, 3, 4)))
print(median(1:4))
print(median(c(5)))
print(median(c(2, 1)))
print(median(c(1, NA, 3)))
print(median(c(1, NA, 3), na.rm = TRUE))
print(median(c(-1.5, 2.5, 0)))
print(median(numeric(0)))
cat(median(c(1, 2, 3, 4)), "\n")

# `rank(x)`：并列取**平均**（R 的默认 `ties.method = "average"`）；
# 缺失留在结果里、排在最后（默认 `na.last = TRUE`），第 k 个缺失拿"非缺失格数 + k"
print(rank(c(3, 1, 2)))
print(rank(c(2, 2, 1)))
print(rank(c(1, 1, 1)))
print(rank(c(3, 1, 4, 1, 5)))
print(rank(c(2, NA, 1)))
print(rank(c(NA, 1, NA)))
print(rank(c(3, NA, 3, 1)))
print(rank(c(-1.5, 2.5, 0)))
print(rank(c(5)))
print(rank(1:4))
cat(rank(c(3, 1, 2)), "\n")
# `diff(x, lag)`：相隔 lag 格相减，长度是 max(0, n - lag)
print(diff(c(1, 4, 9), lag = 2))
print(diff(c(1, 4, 9, 16), lag = 2))
print(diff(c(1, 4), lag = 5))
print(diff(c(1, 4, 9), 2))
print(diff(c(1, 3, 6, 10), lag = 1))

# `cov(x, y)`（= `var(x, y)`）与 `cor(x, y)` —— 都是样本口径（除 n-1），两条要一样长。
# `cor` 的分母照 R 的 `cov.c`：**两个 sqrt 分开乘**（`sd_x * sd_y`），不是 `sqrt(vx*vy)`
x2 <- c(1, 2, 3, 4, 5)
y2 <- c(2, 4, 7, 8, 11)
print(cor(x2, y2))
print(cov(x2, y2))
print(var(x2, y2))
print(cor(c(1, 2, 3), c(3, 2, 1)))
print(cov(c(1, 2), c(5, 9)))
print(cor(x2, x2))
cat(cor(x2, y2), cov(x2, y2), "\n")
print(round(cor(x2, y2), 6))
# **这一格是 fma 的守卫**：R 那边 `sum += (x-m)*(x-m)` 被收缩成一条 fmadd（单次舍入），
# 朴素写成 `s + d*d` 差 1 ulp。印到 17 位才看得见 —— 退回朴素式这一行就会红
bb <- c(1 / 3, 2 / 7, 3 / 11, 4 / 13, 5 / 17, 6 / 19, 7 / 23)
cat(sprintf("%.17g", var(bb)), "\n")
cat(sprintf("%.17g", sd(bb)), "\n")
cat(sprintf("%.17g", cov(bb, c(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7))), "\n")
cat(sprintf("%.17g", cor(bb, c(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7))), "\n")
cat(sprintf("%.17g", mean(bb)), "\n")

# `quantile(x, probs, names = FALSE)` —— R 的默认 **type 7**（与 `median` 同一条）。
# 只接 `names = FALSE`：R 默认回的是带名字的向量（`0% 25% …`），而这一档名字跟着变量走。
# 抄 `quantile.default` 时两处不改写：`(1-h)*a + h*b`（不是 `a + h*(b-a)`）与
# `x[hi] != qs` 那道闸门 —— 印到 17 位才看得出差别
q1 <- c(3, 1, 4, 1, 5, 9, 2, 6)
print(quantile(c(1, 2, 3, 4), names = FALSE))
print(quantile(c(1, 2, 3, 4), 0.5, names = FALSE))
print(quantile(c(1, 2, 3, 4), c(0.1, 0.9), names = FALSE))
print(quantile(q1, c(0, 0.25, 0.5, 0.75, 1), names = FALSE))
print(quantile(c(5), 0.5, names = FALSE))
print(quantile(c(1, 2), 0.5, names = FALSE))
print(quantile(c(2, 1, 3), c(0.33, 0.66), names = FALSE))
print(quantile(q1, 0.5, names = FALSE))
print(median(q1))
cat(sprintf("%.17g", quantile(c(1 / 3, 2 / 7, 3 / 11), 0.42, names = FALSE)), "\n")

# 空向量上的 `min` / `max`（2026-09-26 补的一刀）：R 回 `Inf` / `-Inf`，外带一句**警告**
# —— 警告走 stderr，所以 stdout 两边照样逐字节相同，那句话不发（与"回收长度不是整倍数"
# 那一格同一个办法）。从前这儿只在注释里写着"当场报"，实际上没拦住：去读第 0 格元素，
# 运行期撞 `pointer out of bounds`，而 `print` 的前半行已经印出去了。
print(min(integer(0)))
print(max(numeric(0)))
ez <- c(1, 2)
print(min(ez[ez > 5]))
print(max(ez[ez > 5]))
cat(min(numeric(0)), max(numeric(0)), "\n")
