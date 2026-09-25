# ext/r/examples/apply.R —— `sapply` / `lapply` / `Reduce` / `Filter`：**把那段匿名函数摊开**
#
# R 里这几格收的是一个**函数**。这一档没有闭包与函数值那一层（"R 的函数是值"要连着环境一起
# 搬，那是另一刀）。可真代码里这几格的实参几乎总是**就地写的匿名函数** —— 那时根本不需要
# 函数值：把形参绑到元素上、把函数体当一段表达式摊进循环里就行。账在 `applyOf`。
#
# 所以底子只接"就地写的 `function(…) …`"。而给一个函数**名字**（`sapply(v, sqrt)` /
# `Reduce(`+`, v)`）也接了 —— 办法不是"函数值"，是**先就地改写**成
# `sapply(v, function(.omni.a0) sqrt(.omni.a0))`（见 `nameToLambda`），于是后头那一大段
# 只有一份实现。改写摆在类型推断之前：`f` 的形参装什么只能从那个合成出来的调用点看出来。
# 名字既不是内建、也不是这段里定义过的函数（比如一格传进来的形参）时还是当场报，不猜。
#
# 出来的是哪一种向量看**函数体**：出数是数值向量、出真假是逻辑向量、出串是字符向量。
#
# 两处与 R 不同，都当场报而不是静默差一点：
#   * `lapply` 裸着用 —— R 回一张表，这一层没有"表里装向量"（写 `unlist(lapply(…))`）；
#   * `sapply` / `vapply` 在**字符向量**上 —— R 会拿那些串当结果的**名字**（`USE.NAMES`），
#     而这一层没有 `names`。`unlist(lapply(…))` 那一格没有名字，两边同解。

v <- c(1, 2, 3, 4)

print(sapply(v, function(x) x * 2))
print(sapply(v, function(x) x > 2))          # 出逻辑向量
print(sapply(v, function(x) paste0("#", x))) # 出字符向量
print(unlist(lapply(v, function(x) x + 1)))
print(vapply(v, function(x) x^2, numeric(1)))

# 折叠：不给初值就拿第一格当初值
cat(Reduce(function(a, b) a + b, v), "\n")
cat(Reduce(function(a, b) a * b, v, 1), "\n")

# 挑出来
print(Filter(function(x) x %% 2 == 0, v))

# 字符向量上也一样（`Filter` 不加名字，所以它照旧）
w <- c("ab", "c", "def")
print(unlist(lapply(w, function(s) nchar(s))))
print(Filter(function(s) nchar(s) > 1, w))
cat(Reduce(function(a, b) paste0(a, "-", b), w), "\n")

# 摊开之后那格形参就是循环体里的一格 let —— 所以它跟外面同名的量互不相干
x <- 100
print(sapply(v, function(x) x + 1))
cat(x, "\n")

# 给**函数名字**那一档（改写成匿名函数，见文件头）
dbl <- function(k) k * 2
print(sapply(c(1, 2, 3), dbl))
print(unlist(lapply(c(1, 2), dbl)))
print(sapply(c(1, 4, 9), sqrt))
print(sapply(c(-1, 2), abs))
print(sapply(c(1.4, 2.6), round))
big <- function(k) k > 2
print(Filter(big, c(1, 2, 3, 4)))
# 算子名合成的是 `bin` 节点（方言里 `+` 不是函数）
print(Reduce(`+`, c(1, 2, 3, 4)))
print(Reduce(`*`, c(1, 2, 3, 4)))
# 就地写一层壳子包着别的函数 —— 那格形参的类型从数据那边来
print(sapply(c(1, 2, 3), function(k) dbl(k)))

# `do.call(f, list(…))` —— 第二格是**就地写的 `list(…)`** 时摊成一次普通调用
g2 <- function(x, y) x * 10 + y
print(do.call(sum, list(1, 2, 3)))
print(do.call("sum", list(1, 2)))
print(do.call(max, list(3, 1, 4)))
print(do.call(paste, list("a", "b")))
print(do.call(paste, list("a", "b", sep = "-")))
print(do.call(g2, list(2, 3)))
print(do.call(g2, list(y = 3, x = 2)))
print(do.call(round, list(2.567, 2)))
print(do.call(c, list(1, 2, 3)))
print(do.call(rep, list(5, 3)))
