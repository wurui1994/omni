# ext/r/examples/na.R —— R 的三格"非数"：`NaN` / `Inf` / `-Inf`，与它们的判定
#
# 值由 C 那侧给：`Inf` / `NaN` 走我们那份 `rt/omni_rna.c`（R 那边它们在解释器里，
# standalone 的 nmath 没有），`is.finite` 走 **R 自己的** `R_finite`。
# 印法也是 R 的：`Inf` / `-Inf` / `NaN` 三处特例，别的才是 7 位有效数字。
#
# **`NA` 不在这一份里** —— 它在 JS 这条腿上落不下来（载荷过 N-API 被规范化掉），
# adapter 遇到它当场报。账在 `ext/r/adapter.js` 的 `NA_WHY`。

cat(NaN, "\n", sep = "")
cat(Inf, "\n", sep = "")
cat(-Inf, "\n", sep = "")
cat(1/0, "\n", sep = "")
cat(-1/0, "\n", sep = "")
cat(0/0, "\n", sep = "")
cat(is.nan(0/0), "\n", sep = "")
cat(is.nan(1), "\n", sep = "")
cat(is.finite(1), "\n", sep = "")
cat(is.finite(Inf), "\n", sep = "")
cat(is.finite(NaN), "\n", sep = "")
cat(is.infinite(-Inf), "\n", sep = "")
cat(is.infinite(2.5), "\n", sep = "")
cat(Inf + 1, "\n", sep = "")
cat(NaN + 1, "\n", sep = "")
cat(exp(Inf), "\n", sep = "")
cat(log(0), "\n", sep = "")
