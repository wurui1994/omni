# ext/r/examples/branch.R —— `switch(…)`：R 的分支那一格
#
# R 的 `switch` 有**两套完全不同的规矩**，按选择子的类型分（`do_switch`）：
#
#   选择子是**串** —— 分支按名字配。`a = , b = 2` 那种**空分支往下落**
#                     （`switch("a", a = , b = 2)` 是 2）；最后一格**没名字**的是兜底。
#   选择子是**数** —— 分支按位置配（1 起），分支不该带名字。
#
# 落法是一条 if 链。摆在**语句位**上时每一支是语句（`cat(…)` 只能摆在那儿，见 adapter
# 文件头第 2 条），摆在**表达式位**上时每一支是值（落方言的 `if-expr` —— 那一格每支自己
# 一个语句槽，所以是懒的，与 R 只求被选中那一支一致）。
#
# 尾位上那一格算语句还是值，看**每一支在干什么**（`switchIsStmt`）：每一支都是 `cat` /
# `print` / 赋值那种"做事不交值"的就按语句落，否则按值落 —— 不靠"先试一次报错了再换"，
# 那种写法会把真错吞掉。
#
# 明写的两处不同：
#   * 没配上时 R 回"不可见的 `NULL`"。语句位上那正好是"什么都不做"（一格 else 都不发）；
#     **表达式位**上当场报（要一格兜底）—— 回 0 就是静默答错。
#   * **数**那一档在表达式位上当场报：位置那一档没有"兜底"的写法，而越界时 R 回 `NULL`。

# 串 + 兜底
f <- function(k) switch(k, a = "A", b = "B", "其他")
cat(f("a"), f("b"), f("z"), "\n")

# 空分支往下落
g <- function(k) switch(k, a = , b = "AB", c = "C", "?")
cat(g("a"), g("b"), g("c"), g("x"), "\n")

# 语句位：分支做事、不交值
kind <- "b"
switch(kind, a = cat("是 a\n"), b = cat("是 b\n"), cat("别的\n"))
switch("zz", a = cat("a\n"), b = cat("b\n"))     # 没配上 —— 什么都不做
cat("没配上也没事\n")

# 数那一档（语句位）
n <- function(i) switch(i, cat("one\n"), cat("two\n"), cat("three\n"))
n(1)
n(3)
n(9)                                             # 越界 —— 什么都不做

# 当值用（分支名只能是 ASCII —— 非 ASCII 的名字这一档没有，见 SPEC §4 第 7 条）
x <- switch("m", m = 10, n = 20, 0)
cat(x + 1, "\n")
sizes <- c("sm", "md", "lg")
for (s in 1:3) cat(switch(sizes[s], sm = "S", md = "M", lg = "L", "?"), "")
cat("\n")

# **花括号括住一支**：R 里 `{ … }` 的值就是里头最后一格，所以只有一格的 `{ x }` 就是 x。
# 要紧的是这说明"见着花括号就断定是语句"是错的 —— 每一支都写成 `{ … }` 的 switch
# 交的仍然是**值**（从前那种函数的回值落成 void，而那一格是在公共 lower 那层才炸）。
blkS <- switch("two", one = { "1" }, two = { "2" }, "other")
cat(blkS, "\n")
blkG <- switch("z", one = { 1 }, two = { 2 }, { 99 })
cat(blkG, "\n")
cat({ 7 }, "\n")
blkV <- c({ 1 }, { 2 }, 3)
cat(blkV, "\n")
blkB <- if (length(blkV) > 2) { "长" } else { "短" }
cat(blkB, "\n")
cat(sapply(1:4, function(k) { k * k }), "\n")
cat(sapply(c("a", "bb"), function(z) { nchar(z) }), "\n")
blkF <- function(i) if (i > 0) { i } else { -i }
cat(blkF(3), blkF(-3), "\n")
blkK <- function(k) switch(k, a = { "甲" }, b = { "乙" }, { "别的" })
for (k in c("a", "b", "c")) cat(k, blkK(k), "\n")
blkT <- 0
for (i in 1:3) blkT <- blkT + { i * 2 }
cat(blkT, "\n")
cat(Reduce(function(a, b) { a + b }, 1:5), "\n")
cat(unlist(Filter(function(z) { z %% 2 == 0 }, 1:8)), "\n")

# **`v <- switch(…)` 里某一支是多格 `{ … }`**：按**目标导向**落 —— switch 本来就落成一条
# if 链，每一支自己做前面那几格、再把最后一格赋给 v。表达式位上摆不下那几格，而 if 链的
# 每一支就是个语句槽。R 里花括号**不开作用域**，所以前面那几格是这一层的普通语句
# （与 apply 那一族正相反，那儿是函数体、体里的 `<-` 是局部量）。
swOps <- c("push", "push", "add", "dup", "mul", "bad", "show")
swStk <- numeric(0)
swN <- 0
for (i in seq_along(swOps)) {
  swOp <- swOps[i]
  swR <- switch(swOp,
    push = { swN <- swN + 1; swStk <- c(swStk, swN); "ok" },
    add = { swStk <- c(swStk[1], sum(swStk)); "ok" },
    dup = { swStk <- c(swStk, swStk[length(swStk)]); "ok" },
    mul = { swStk <- c(prod(swStk)); "ok" },
    show = { cat("栈:", swStk, "\n"); "ok" },
    "不认识")
  cat(i, swOp, swR, "\n")
}
swCnt <- 0
swLab <- switch("b", a = { swCnt <- swCnt + 1; "甲" }, b = { swCnt <- swCnt + 10; "乙" },
                { swCnt <- 99; "别的" })
cat(swLab, swCnt, "\n")
swLab2 <- switch("zz", a = { swCnt <- 1; "甲" }, { swCnt <- swCnt + 5; "兜底" })
cat(swLab2, swCnt, "\n")
swNum <- switch("two", one = { 1 }, two = { swT <- 2; swT * 10 }, 0)
cat(swNum, "\n")

# **选择子是个数字面量时这一格编译期就定了**（位置按 1 起数）—— 于是表达式位上也没有
# "越界回 NULL"那个问题了。越界（`switch(9, …)`）照旧当场报。
cat(switch(2, "一", "二", "三"), "\n")
cat(switch(1, "甲", "乙"), switch(3, 10, 20, 30), "\n")
cat(switch(2L, "p", "q"), "\n")
swPick <- switch(3, "a", "b", "c")
cat(swPick, "\n")
cat(nchar(switch(1, "abc", "de")), "\n")

# **`for (i in a:b)` 里 `:` 会倒着走** —— `1:0` 是 `c(1, 0)`，不是空的。
# 从前这一格一律发"从 a 数到 b、每圈 +1"，于是 `m <- 0; for (i in 1:m)` 一圈都不转，
# 而 R 转**两圈**（i 取 1 再取 0）—— 静默改掉了控制流，比答错一个数更难看出来。
# 两头都是字面量时方向编译期就定；有一头是运行期的值时上下界各存一格临时量
# （R 的 `:` 只求值一次），条件写成 `(i - hi) * d <= 0`，一条式子管两个方向。
m <- 0
for (i in 1:m) cat("y")
cat("|", "\n")
for (i in 1:0) cat(i)
cat("|", "\n")
for (i in 3:1) cat(i)
cat("|", "\n")
a <- 5
b <- 2
for (i in a:b) cat(i)
cat("|", "\n")
a <- 2
b <- 5
for (i in a:b) cat(i)
cat("|", "\n")
lo <- -1
hi <- -3
for (i in lo:hi) cat(i, "")
cat("|", "\n")
tot <- 0
for (i in 5:1) { if (i == 3) break; tot <- tot + i }
cat(tot, "\n")
tot <- 0
for (i in 1:5) { if (i %% 2 == 0) next; tot <- tot + i }
cat(tot, "\n")
v <- c(1, 2, 3)
for (i in 1:length(v)) cat(v[i])
cat("|", "\n")
for (i in seq_len(0)) cat("z")
cat("|", "\n")
