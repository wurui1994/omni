# ext/r/examples/named.R —— 带名字的向量：`c(a = 1, …)` / `names` / `setNames` / `v["a"]`
#
# R 的名字是**属性**（挂在 SEXP 上），而这一档的向量就是一块 `(ptr real)`，没地方挂。
# 落法是把名字另放一条 `(arr string)`，**跟着变量走**：`v` 的名字摆在 `v__nm` 里。
#
# 这么分的代价是"名字跟不住"的地方多：R 里 `sort(v)` / `rev(v)` / `head(v)` / `cumsum(v)` /
# `abs(v)` / `round(v, 1)` / `is.na(v)` / `c(v, 4)` / `v[v > 1]` **都把名字带过去**，
# 而这一层只带值。那些地方一律**当场报** —— 静默丢掉的话 `print` 会少印名字那一行，
# 而例子的判据是逐字节对 `Rscript`，那种错最难查。要丢就自己写 `unname(v)`。
#
# 印法照 R 的两行版式：名字一行、值一行，两行**共用一个宽** `max(值的宽, 最长的名字)`，
# 每格右对齐到那个宽再跟一个空格 —— 所以**每行末尾有一个空格**。一行几格是
# `floor(80 / (宽 + 1))`，这一档没有 `[1]` 那个标号。

# 造的时候就带名字
v <- c(a = 1, bb = 22.5)
print(v)

w <- c(alpha = 1, b = 2, ccc = 333.25)
print(w)

# 名字读出来是一条字符向量（没给名字的那几格是空串 —— R 也是）
print(names(w))
print(names(c(a = 1, 2)))

# 逐元素算术：名字跟着走（R 也是这么传的）
print(w * 2)
print(w / 2)

# setNames / unname
u <- setNames(c(1, 2, 3), c("x", "yy", "zzz"))
print(u)
print(unname(u))

# 名字后补上
z <- c(1, 2)
names(z) <- c("p", "q")
print(z)

# 按名字取一格；找不到那个名字时 R 印的是 `<NA>` / `NA`
print(u["yy"])
print(u["nope"])
# 双方括号那一档**不带名字**（R 的规矩）
print(u[["yy"]])
# 单方括号按位置取：名字也跟着
print(u[2])

# 名字用起来：按名字取值算，不必记位置
cat(u[["x"]] + u[["zzz"]], "\n")
for (k in names(u)) cat(k, "=", u[[k]], "\n")

# 换行：一行装得下 20 格（宽 3 + 1 个空格）
long <- setNames(seq_len(30), paste0("n", seq_len(30)))
print(long)

# 名字丢掉之后印的就是普通向量
z2 <- c(10, 20, 30)
names(z2) <- c("i", "j", "k")
z2 <- unname(z2)
print(z2)

# 汇总那一族 R 自己也丢名字，所以照样能算
cat(sum(w), mean(w), length(w), "\n")

# 带名字的**逻辑**向量（2026-09-26 接了）：版式与数值那一格同形 —— 名字一行、值一行、
# 两行共用一个宽 `max(TRUE/FALSE/NA 的宽, 最长的名字)`，值那一行印 `TRUE` / `FALSE` / `NA`。
# 从前比较那一格的结果一律落"没名字的逻辑向量"，印出来少名字那一行；`c(a = TRUE, …)` 更糟，
# 落到数值那一格印成 `1` / `0`。
print(v > 1)
print(w >= 2)
print(c(a = TRUE, b = FALSE))
print(!(w > 1))
print(setNames(c(TRUE, NA, FALSE), c("p", "qq", "r")))
# NA 也进这一格（`NA` 的宽是 2，比名字短就跟着名字撑开）
print(setNames(c(TRUE, NA), c("yes", "dunno")))
# 零长那一档印的是 `named logical(0)`
print(setNames(c(TRUE)[c(FALSE)], character(0)))

# 逐元素、**位置不动**的那几格名字也跟着（2026-09-26 接了 —— 量出来 R 全带名字）：
# 数学那一族与累加那一族。动位置或动长度的（`sort` / `rev` / `head` / `diff`）还是当场报。
m <- c(a = 1, bb = 4, ccc = 9.25)
print(sqrt(m))
print(abs(-m))
print(round(m, 1))
print(floor(m))
print(exp(c(p = 0, q = 1)))
print(log(c(p = 1, q = 100)))
print(log10(c(p = 1, q = 100)))
print(cumsum(m))
print(cumprod(c(a = 2, b = 3)))
print(signif(m, 2))
# 套起来也跟得住（名字跟着**变量**走，中间那一格是个表达式）
print(round(sqrt(m), 3))
print(sqrt(m) * 2)

# 位置动了那几格：`rev` / `head` / `tail` / `sort` 的名字**跟着动**（2026-09-26 接了）。
# `diff` 还要丢掉第一格，那一格还没接。
kv <- c(a = 1, bb = 4, ccc = 9.25, d = 2)
print(rev(kv))
print(head(kv, 2))
print(tail(kv, 2))
print(head(kv))          # 缺省取 6 格（比长度大就整条）
print(tail(kv, n = 3))   # `n =` 也认
print(rev(rev(kv)))
print(head(rev(kv), 2))
print(rev(c(p = TRUE, q = FALSE)))
print(names(rev(kv)))
print(tail(kv, 0))       # 零长那一档

# `sort` 的名字按**排序那个置换**挑一遍（`r_nm_sort`）。缺失那几格跟着值一起丢 ——
# R 的 `sort` 缺省 `na.last = NA`，而 `r_order` 把缺失排最后，两边长度因此对得上。
sv <- c(b = 3, a = 1, ccc = 2)
print(sort(sv))
print(sort(sv, decreasing = TRUE))
print(names(sort(sv)))
print(rev(sort(sv)))
print(head(sort(sv), 2))
print(sort(c(b = 3, a = 1, d = NA)))   # 缺失连名字一起丢
print(sort(c(z = 2, y = 2, x = 1)))    # 同值的次序是唯一的（原下标当最后一把钥匙）
print(sort(c(only = 1)))

# 挑出来那几格的名字也跟着（2026-09-26 接了）：掩码、下标向量、写着负号的那一档，
# 名字那一条走字符向量上同一对辅助函数，于是"掩码短了从头再来"、"下标 0 跳过"、
# "负下标是丢掉"这几条两边一定同解。
pk <- c(a = 1, bb = 4, ccc = 9)
print(pk[pk > 1])
print(pk[c(1, 3)])
print(pk[c(TRUE, FALSE, TRUE)])
print(pk[-2])
print(pk[c(1, 0, 2)])    # 下标 0 跳过
print(pk[c(3, 1)])       # 次序按下标那条走
print(pk[c(1, 5)])       # 越界那一格：值是 NA、名字印 `<NA>`
print(pk[pk > 100])      # 一格都没挑着 → 零长
print(names(pk[-1]))
cat(sum(pk[pk > 1]), "\n")

# `c(…)` 里名字是**接起来**的（2026-09-26 接了）：带名字的向量把它那几格名字逐格抄过来，
# 不带名字的那几格补空串（R 印出来那一列是空的），写着名字的字面量照写。
cv <- c(a = 1, bb = 4)
cu <- c(3, 9)
print(c(cv, 4))
print(c(cv, d = 4))
print(c(cv, cu))
print(c(cu, cv))
print(c(cv, cv))
print(c(1, cv))
print(c(cv, c(z = 7)))
print(names(c(cv, 4)))
print(c(c(p = TRUE), FALSE))
cat(sum(c(cv, 4)), "\n")

# 按名字**一次取多格**（2026-09-26 接了）：找着的按 R 的规矩取第一处，找不着的
# 值是 `NA`、名字那一行印 `<NA>`。
nk <- c(a = 1, bb = 4, ccc = 9)
print(nk[c("a", "ccc")])
print(nk[c("a", "zz")])
print(nk[c("bb")])
print(nk[c("ccc", "a")])
print(nk[character(0)])
cat(sum(nk[c("a", "bb")]), "\n")
# `names(v[按名字挑])` 那一格**当场报**（退到 libR）：找不着的那一格 R 给的是
# `NA_character_`，这一层没有串的缺失 —— 名字那一行印的 `<NA>` 只是"印出来的样子"，
# 当数据用会静默差一格。所以这儿不写那种形状。

# `table(v)`（2026-09-26 接了）：值是计数、名字是那几个取值印出来的样子（`as.character`
# 的 15 位口径）。取值那几格照 R 的 `factor(v)` = `sort(unique(v))`，所以 `NA` 跟着
# `sort` 一起丢（R 缺省 `useNA = "no"`）。印法与带名字的向量同形，只差两处：前头**多空
# 一行**（dimnames 的名字那一行，空的），零长那一档印 `< table of extent 0 >`。
print(table(c(1, 1, 2)))
print(table(c(3, 1, 2, 1, 3, 3)))
print(table(c(TRUE, FALSE, TRUE)))
print(table(c(10, 200, 10)))
print(table(c(1.5, 1.5, 2)))
print(table(c(1, NA, 1)))     # 缺失那一格不算
print(table(numeric(0)))
tb <- table(c(2, 2, 1))
print(tb)
print(names(tb))
cat(sum(tb), length(tb), "\n")
print(tb[1])
for (k in names(tb)) cat(k, "")
cat("\n")
# 字符向量那一侧还没接（R 的 levels 要按 locale collation 排）—— 所以这儿不写。

# 又三格名字（2026-09-26）：`rank` 位置不动所以原样跟着；`diff` **丢掉前 lag 格**
# （出来第 i 格是 `v[i+lag] - v[i]`，R 拿后面那一格的名字）；`which.max` / `which.min`
# 回的是位置，而 R 连那一格的名字一起回 —— 所以出来是一条**长度 1** 的带名字的向量。
dv <- c(a = 3, bb = 1, ccc = 2)
print(rank(dv))
print(diff(dv))
print(diff(dv, lag = 2))
print(names(diff(dv)))
print(which.max(dv))
print(which.min(dv))
print(diff(c(a = 1, b = 2, c = 4, d = 8)))
cat(sum(diff(dv)), "\n")
# 负的 `n`：`head(v, -1)` 是"去掉最后一格"、`tail(v, -1)` 是"去掉第一格"（名字跟着）
print(head(dv, -1))
print(tail(dv, -1))

# `replace` / `unlist` / `append`（2026-09-26 接了）：`replace(v, i, val)` 换的是**值**，
# 长度与位置都不动，所以名字原样跟着；`unlist(一条原子向量)` 就是它自己；
# `append` 插进去那几格在 R 里**名字是空串**（印出来那一列是空的）。
av <- c(a = 1, bb = 2, ccc = 3)
print(replace(av, 2, 99))
print(unlist(av))
print(append(av, 9))
print(append(av, 9, after = 1))
print(append(av, 9, after = 0))
print(append(av, c(8, 9), after = 2))
print(names(append(av, 9)))
cat(length(append(av, 9)), sum(append(av, 9)), "\n")
