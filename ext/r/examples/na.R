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
