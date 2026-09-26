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
# `mapply` 是两条向量逐元素那一格（长度两头回收）；`do.call(f, list(…))` 摊成一次普通调用。
#
# 出来的是哪一种向量看**函数体**：出数是数值向量、出真假是逻辑向量、出串是字符向量。
#
# `sapply` / `vapply` 在**字符向量**上 R 会拿那些串当结果的**名字**（`USE.NAMES`）—— 这一格
# 2026-09-26 接了：出来的是**带名字的**向量（数值那一格 `RNVEC`、真假那一格 `RNLGL`），名字就是
# 那条输入本身（见 `namesExprOf`；代价是那条输入的表达式**算两遍**，所以别在里头写带副作用的）。
# 函数体出**串**那一格还没接（没有带名字的字符向量，见 SPEC §2），当场报。
# `unlist(lapply(…))` 那一格照 R 一样没有名字，可以拿它绕开。
#
# 一处与 R 不同，当场报而不是静默差一点：
#   * `lapply` 裸着用 —— R 回一张表，这一层没有"表里装向量"（写 `unlist(lapply(…))`）。

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

# `mapply(f, v1, v2)` —— 两条向量逐元素，长度**两头回收**（与 `pmax` 同一条）
print(mapply(function(a, b) a + b, c(1, 2), c(3, 4)))
print(mapply(function(a, b) a * b, c(1, 2, 3), c(2, 2, 2)))
print(mapply(function(a, b) a > b, c(1, 5), c(3, 2)))
print(mapply(function(a, b) a + b, c(1, 2, 3, 4), c(10, 20)))
print(mapply(function(a, b) a - b, 1:3, 1:3))
add2 <- function(p, q) p + q
print(mapply(add2, c(1, 2), c(5, 6)))
print(mapply(`+`, c(1, 2), c(5, 6)))
cat(sum(mapply(function(a, b) a * b, c(1, 2), c(3, 4))), "\n")

# `USE.NAMES`：字符向量上 `sapply` / `vapply` 拿那些串当名字（印法是名字一行、值一行）
ws <- c("ab", "c", "def")
print(sapply(ws, nchar))
print(sapply(ws, function(s) nchar(s) * 2))
print(vapply(ws, nchar, integer(1)))
print(sapply(ws, function(s) nchar(s) > 1))   # 真假那一格：带名字的逻辑向量
print(sapply(c("one"), function(s) nchar(s))) # 一格也照样有名字
# 名字跟着**变量**走，所以接出来还能问名字
sn <- sapply(ws, nchar)
print(sn)
print(names(sn))
# 汇总那一族 R 自己丢名字，所以照旧
cat(sum(sapply(ws, nchar)), "\n")
# `unlist(lapply(…))` 两边都没有名字
print(unlist(lapply(ws, nchar)))

# **函数体写成 `{ … }` 且里头两格以上**：前面那几格是"每一趟都要做的事"、最后一格才是
# 这一趟的值（R 的语义）。表达式位上摆不下它们，可摊开之后**循环体就是那个语句槽**。
# 体里的 `名字 <- 值` 一律是**局部量**（R 也是这样），所以就地发一格 let —— 外头同名那个
# 看不见也改不着；同一个名字赋第二遍才是重新赋值。
cat(sapply(1:4, function(k) { y2 <- k * 2; y2 + 1 }), "\n")
cat(sapply(c("ab", "c"), function(s) { n2 <- nchar(s); paste0(s, n2) }), "\n")
cat(sapply(1:4, function(k) { a2 <- k + 1; a2 <- a2 * 2; a2 - 1 }), "\n")
cat(sapply(1:4, function(k) { if (k > 2) k * 10 else 0 }), "\n")
cat(vapply(1:3, function(k) { d2 <- k + 0.5; d2 * 2 }, numeric(1)), "\n")
cat(unlist(lapply(1:3, function(k) { e2 <- k * k; e2 + 1 })), "\n")
cat(unlist(Filter(function(z) { m2 <- z %% 3; m2 == 0 }, 1:12)), "\n")
cat(Reduce(function(p2, q2) { t2 <- p2 * q2; t2 + 0 }, 1:5), "\n")
cat(sapply(1:3, function(k) { b2 <- k > 1; b2 }), "\n")
out2 <- 99
cat(sapply(1:2, function(k) { out2 <- k; out2 }), out2, "\n")

# **`mapply` 的字符向量与出串那两档**（2026-09-26）：两格数据各自可以是数值向量或
# 字符向量（形参一格一格地绑），函数体出串时结果是一条字符向量。
# 名字照 R 的 `USE.NAMES` **只从第一格数据来**，而且只在那一格是字符向量时 ——
# 量出来 `mapply(f, c(1,2), c("x","y"))` 是**没名字**的。长度照旧两头回收。
cat(mapply(function(a, b) paste0(a, b), c("x", "y"), c("1", "2")), "\n")
print(mapply(function(a, b) paste0(a, b), c("x", "y"), c("1", "2")))
print(mapply(function(a, b) paste0(a, b), c(1, 2), c("x", "y")))
print(mapply(function(s, n) nchar(s) + n, c("ab", "cde"), c(1, 2)))
print(mapply(function(a, b) a > b, c(1, 5), c(3, 3)))
print(mapply(function(a, b) a + b, c(1, 2), c(10, 20)))
cat(mapply(function(a, b) paste0(a, b), c("p", "q", "r"), c("1")), "\n")
cat(names(mapply(function(a, b) paste0(a, b), c("x", "y"), c("1", "2"))), "\n")
cat(length(mapply(function(a, b) a + b, c(1, 2, 3), c(1))), "\n")
cat(mapply(function(a, b) toupper(paste0(a, b)), c("a"), c("b")), "\n")

## Reduce(accumulate = TRUE)：每一步的中间值（有初值就多一格，头一格是初值）
cat(Reduce(function(a, b) a + b, c(1, 2, 3, 4), accumulate = TRUE), "\n")
print(Reduce(function(a, b) a + b, c(1, 2, 3, 4), accumulate = TRUE))
cat(Reduce(function(a, b) a * b, c(1, 2, 3, 4), 10, accumulate = TRUE), "\n")
cat(Reduce(function(a, b) paste0(a, b), c("x", "y", "z"), accumulate = TRUE), "\n")
print(Reduce(function(a, b) paste0(a, b), c("x", "y", "z"), accumulate = TRUE))
cat(Reduce(function(a, b) if (a > b) a else b, c(3, 9, 2), accumulate = TRUE), "\n")
cat(length(Reduce(function(a, b) a + b, c(5), accumulate = TRUE)), "\n")
## accumulate = FALSE 与不写是同一件事
cat(Reduce(function(a, b) a + b, c(1, 2, 3), accumulate = FALSE), "\n")
