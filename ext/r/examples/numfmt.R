# ext/r/examples/numfmt.R —— R 印一个 double 时"定点还是科学记数"
#
# 这一格不是 C 的 `%g`。`%g` 按**指数**挑（`-4 <= X < 7` 用定点），R 按**哪个短**挑：
# `formatReal()` 算出定点要几格、科学记数要几格，短的那个赢（平手偏定点，因为
# `scipen` 是 0）。于是 `1e5` 印 `1e+05`（5 格 < 6 格）而 `123456` 印 `123456`
# （6 格 < `1.23456e+05` 的 11 格）—— 两个数量级一样大，挑法却相反。
#
# 有效数字是 7 位（`options(digits = 7)`），但**尾随零不算**：`1.5` 的 nsig 是 2，
# 所以印 `1.5` 而不是 `1.500000`。
#
# 两处压着边界的值：
#   * `9996` —— 按 7 位有效数字它是定点；R 里那格 `roundingwidens` 管的是位数更少时
#     科学记数会把它舍成 `1e+04`（反而变宽）的情形。
#   * `1000000.5` —— 舍到 7 位有效数字要**就近取偶**，得 `1000000`（nsig = 1），
#     于是印 `1e+06`。离零舍入会得 `1000001`（nsig = 7），印出来就不一样了。
#
# 抄的是 `src/main/format.c` 的 `scientific()` + `formatReal()`，账在
# `ext/r/adapter.js` 的 `numFmtStmts()`。整数写法的字面量（`5` / `42L`）在这一档是
# `int`，不走这条路 —— 见 SPEC 第四节第 8 条。

cat(0.0, "\n", sep = "")
cat(1.0, "\n", sep = "")
cat(1.5, "\n", sep = "")
cat(15.0, "\n", sep = "")
cat(0.5, "\n", sep = "")
cat(2.5, "\n", sep = "")

# 同一个数量级，挑法相反
cat(1e5, "\n", sep = "")
cat(1.23456e5, "\n", sep = "")
cat(1.234567e6, "\n", sep = "")
cat(1.2345678e7, "\n", sep = "")
cat(1.23456789e8, "\n", sep = "")

# 小的那一头
cat(1e-5, "\n", sep = "")
cat(1e-4, "\n", sep = "")
cat(1e-3, "\n", sep = "")
cat(1.2345e-4, "\n", sep = "")
cat(7e-8, "\n", sep = "")

# 除不尽的：7 位有效数字
cat(1 / 3, "\n", sep = "")
cat(2 / 3, "\n", sep = "")
cat(0.1 + 0.2, "\n", sep = "")
cat(3.141592653589793, "\n", sep = "")
cat(1.2345678e3, "\n", sep = "")
cat(9.999999e5, "\n", sep = "")

# 两头的极端：指数要三位、以及 double 能表示的两端
cat(1e15, "\n", sep = "")
cat(1e-15, "\n", sep = "")
cat(1e22, "\n", sep = "")
cat(1e23, "\n", sep = "")
cat(1e100, "\n", sep = "")
cat(1e-100, "\n", sep = "")
cat(2.2250738585072014e-308, "\n", sep = "")
cat(5e-324, "\n", sep = "")

# 符号那一格（宽里要算上它）
cat(-1e5, "\n", sep = "")
cat(-0.5, "\n", sep = "")
cat(-1e-7, "\n", sep = "")

# 压边界的两个
cat(9996.0, "\n", sep = "")
cat(1000000.5, "\n", sep = "")

# 那三处特例照旧
cat(NA, "\n", sep = "")
cat(NaN, "\n", sep = "")
cat(Inf, "\n", sep = "")
cat(-Inf, "\n", sep = "")

# 向量里每一格各自挑（`r_cat_vec` 走的是同一个 `r_num_str`）
cat(c(1e5, 123456.0, 1e-5, 0.5), "\n")

# **负零**：IEEE 有 `-0.0`，而 C 的 `%.*f` 把它印成 `-0`。R 在 `EncodeReal0` 里有一句
# `if(x == 0.) x = 0.;`（`-0.0 == 0.0` 为真，换成正零），所以 R 印的是 `0` —— 我们跟着归一。
# `sprintf` 那一格 R **不**归一（它直接走 C 的 sprintf），所以两边都是 `-0.0`。
print(-0.0)
cat(-0.0, "\n")
cat(as.character(-0.0), "\n")
print(c(-0.0, 1))
print(c(0, -0.0))
cat(0 * -1, -1 * 0, "\n")
cat(sprintf("%.1f", -0.0), "\n")

# `format(x, nsmall =, width =)` —— **只接标量**（向量那一档 R 会算一套共用的宽与小数位）
print(format(1.5))
print(format(1 / 3))
print(format(100000))
print(format(123))
print(format(0))
print(format(NA))
print(format(NaN))
print(format(Inf))
print(format(1e-5))
print(format(123456789))
print(format(0.1 + 0.2))
print(format(TRUE))
print(format("ab"))
# `nsmall` 是"**至少** k 位小数"，而且只在**定点**那一侧管
print(format(3.14159, nsmall = 2))
print(format(2, nsmall = 2))
print(format(1.5, nsmall = 3))
print(format(-2.5, nsmall = 1))
print(format(1e5, nsmall = 2))
print(format(1 / 3, nsmall = 2))
# `width` 是"至少 k 宽"：数与真假右对齐、串左对齐
print(format(2, width = 5))
print(format(1.5, width = 8))
print(format(TRUE, width = 6))
print(format("a", width = 4))
print(format("abcdef", width = 3))
cat(nchar(format(2, width = 5)), "\n")
