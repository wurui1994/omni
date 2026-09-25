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
