# ext/r/examples/na.R —— R 的三格"非数"：`NaN` / `Inf` / `-Inf`，与它们的判定
#
# 值由 C 那侧给：`Inf` / `NaN` 走我们那份 `rt/omni_rna.c`（R 那边它们在解释器里，
# standalone 的 nmath 没有），`is.finite` 走 **R 自己的** `R_finite`。
# 印法也是 R 的：`Inf` / `-Inf` / `NaN` 三处特例，别的才是 7 位有效数字。
#
# `NA` 也在这一份里 —— 它是"带 1954 载荷的 NaN"，而那个载荷**按值过 N-API 会被规范化掉**。
# 所以 R 的 double 在这条腿上**按指针过 FFI**（`(pnew (ptr real) 1)` + 按位读写），
# 三格封在生成出来的 `r_na` / `r_is_na` / `r_is_nan` 里。量出来的三档摆在
# `ext/r/adapter.js` 的 `PTR_REAL` 那段账上：按值 `1 1`（错）、按指针 `1 0`（对）。
#
# 于是 R 那两条区别立住了：`is.na(NaN)` 真、`is.nan(NA)` 假。

cat(NA, "\n", sep = "")
cat(NaN, "\n", sep = "")
cat(Inf, "\n", sep = "")
cat(-Inf, "\n", sep = "")
cat(1/0, "\n", sep = "")
cat(-1/0, "\n", sep = "")
cat(0/0, "\n", sep = "")
cat(is.na(NA), "\n", sep = "")
cat(is.na(NaN), "\n", sep = "")
cat(is.na(1), "\n", sep = "")
cat(is.nan(NA), "\n", sep = "")
cat(is.nan(0/0), "\n", sep = "")
cat(is.nan(1), "\n", sep = "")
cat(is.finite(1), "\n", sep = "")
cat(is.finite(Inf), "\n", sep = "")
cat(is.finite(NaN), "\n", sep = "")
cat(is.infinite(-Inf), "\n", sep = "")
cat(is.infinite(2.5), "\n", sep = "")
cat(Inf + 1, "\n", sep = "")
cat(NaN + 1, "\n", sep = "")
cat(NA + 1, "\n", sep = "")
cat(is.finite(NA), "\n", sep = "")
cat(exp(Inf), "\n", sep = "")
cat(log(0), "\n", sep = "")

# 这四格**在一条向量上**逐元素出一条逻辑向量（2026-09-26 接了 —— 从前只有标量那一档，
# 给一条向量会一路走到 `.sx` 才撞上 `(toreal E) 的参数要是 int，这里是 real*`）。
# 出来的值只有 TRUE / FALSE，**没有 NA**：这四格都是"问一句"，`is.finite(NA)` 是 FALSE。
xs <- c(1, NA, NaN, Inf, -Inf, 2.5)
print(is.na(xs))
print(is.nan(xs))
print(is.finite(xs))
print(is.infinite(xs))
print(!is.na(xs))
# 接着用：按"不缺失"挑出来、数一数
print(xs[!is.na(xs)])
cat(sum(is.na(xs)), "\n", sep = "")
cat(any(is.na(xs)), " ", all(is.finite(xs)), "\n", sep = "")
# 带名字的向量上名字**跟着走**（R 也是；`duplicated` 相反，R 自己就丢）
v <- c(a = 1, b = NA, ccc = 3)
print(is.na(v))
print(is.finite(v))
print(!is.na(v))
print(duplicated(c(x = 1, y = 1, z = 2)))
# 零长那一档
print(is.na(numeric(0)))

# `as.logical` 接了（2026-09-26）—— 它回的是**三态**，所以判据摆在这一份里。
# 数那一侧 0 假、非零真（`Inf` 也真）、缺失 `NA`；串那一侧 R 只认**八种写法**
# （`util.c` 的 `StringTrue` / `StringFalse`），别的一律 `NA` —— 量出来小写单字母
# `"t"` / `"f"` 是 `NA`，`"yes"` / `"1"` / `""` 也是 `NA`（所以不能写成"非空就真"）。
# 名字**不跟着走**（R 自己就丢，与 `as.numeric` / `as.integer` 同一批）。
print(as.logical(0))
print(as.logical(1))
print(as.logical(-2.5))
print(as.logical(Inf))
print(as.logical(NA))
print(as.logical(NaN))
print(as.logical(TRUE))
print(as.logical(c(0, 1, 2, NA)))
print(as.logical("TRUE"))
print(as.logical("true"))
print(as.logical("True"))
print(as.logical("T"))
print(as.logical("FALSE"))
print(as.logical("false"))
print(as.logical("False"))
print(as.logical("F"))
print(as.logical("t"))
print(as.logical("f"))
print(as.logical("yes"))
print(as.logical("1"))
print(as.logical(""))
print(as.logical(c("TRUE", "no", "F")))
print(as.logical(character(0)))
cat(as.logical(0), as.logical("T"), as.logical("x"), "\n")
print(sum(as.logical(c(1, 0, 2))))
print(!as.logical(0))
print(as.logical(0) || TRUE)
print(as.logical("T") && as.logical("no"))
print(is.na(as.logical("yes")))
print(as.logical(c(a = 1, b = 0)))

# **`identical()` 只接"两边都是一格标量"那一档**：R 先看 `typeof` 一不一样、再看值。
# 类型那一半编译期就答得出来（不带 L 的字面量是 double、`1L` 是 int）。值那一半 double
# 要紧的是**把 `NA_real_` 与 `NaN` 分开** —— `r_is_na` 是 R 的 `is.na`（两格都真），
# 所以"真的 NA"= `is.na(x) && !is.nan(x)`。量出来 `identical(NA, NaN)` 是 FALSE。
# 向量那一档照旧不接（这一层分不出 integer 向量与 double 向量，见 SPEC 第四节第 13 条）。
cat(identical(1, 1), identical(1, 1L), identical(1L, 1L), "\n")
cat(identical("a", "a"), identical("a", "b"), "\n")
cat(identical(TRUE, TRUE), identical(TRUE, FALSE), identical(TRUE, 1), "\n")
cat(identical(NA, NA), identical(NaN, NaN), identical(NA, NaN), "\n")
cat(identical(0, -0), identical(1/0, 1/0), identical(1, 2), "\n")
cat(identical(NA, 1), identical(NA, TRUE), "\n")
idx1 <- 3
idy1 <- 3
cat(identical(idx1, idy1), identical(idx1, 4), "\n")
cat(identical(2L, 2L), identical(2L, 3L), "\n")
cat(identical(-1/0, -1/0), identical(1/0, -1/0), "\n")

# **串那一侧问缺失**：这一档没有 `NA_character_`（见 SPEC 第四节），所以一格串永远不是
# 缺失 —— `is.na("NA")` 是 FALSE（R 也是：那是三个字符，不是缺失），字符向量上出一条
# 全 FALSE 的逻辑向量。从前这儿照走 `asReal`，发出来是 `(toreal (str "NA"))`，
# 一路到 `.sx` 才撞上，而那时已经过了换档那道门（退 1、什么都不印）。
cat(is.na("NA"), is.na(NA), is.na("a"), is.na(""), "\n")
cat(is.nan("NA"), is.nan("a"), "\n")
cat(is.na(c("a", "NA")), is.nan(c("a", "b")), "\n")
s <- "NA"
cat(is.na(s), "\n")
sv <- c("x", "y", "z")
cat(is.na(sv), length(is.na(sv)), sum(is.na(sv)), any(is.na(sv)), "\n")
print(is.na(c("a", "b")))
