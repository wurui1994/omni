# ext/python/examples/numbers.py —— 数那一族：python 与 C 分道的每一处
#
# 这一份的每一行都是**判据**：整除向下取整、取模符号跟着除数、`/` 永远是浮点、
# 浮点转串是最短往返。任一处走了 C 的口径，与 python3 的 diff 立刻现形。
#
# **python 的 bool 就是 int 的一种**（`True + True` 是 2）—— 方言里那是两档类型，
# 所以当数用的时候现折一格 `b ? 1 : 0`。位运算**不折**：python 的 `True & True` 交的是
# `True` 而不是 `1`，印出来不一样，所以那一格还是当场报（明说的不足）。
import math


def bool_as_int():
    print(True + True, True * 2, int(True), int(False))
    print(True + 1, 1 + True, True - False, True + 1.5)
    print(2 ** True, True / 2, True // 1, True % 2)


def divmods():
    # 交一格两格的元组；取整与取模走的就是 `//` / `%` 那两份
    print(divmod(7, 3), divmod(-7, 2), divmod(7, -2), divmod(-7, -2))
    print(divmod(7.5, 2), divmod(-7.5, 2))


def floor_div_table():
    print(7 // 2, -7 // 2, 7 // -2, -7 // -2)
    print(7 % 2, -7 % 2, 7 % -2, -7 % -2)
    print(7 / 2, -7 / 2, 6 / 3)
    print(7.5 // 2, -7.5 // 2)
    print(7.5 % 2, -7.5 % 2)


def powers():
    print(2 ** 10, 2 ** 0, 0 ** 0)
    print(2 ** 0.5)
    print(2.0 ** 3)


def floats():
    # 最短往返：这几格用 %.6g 会分别印成 4、0.1、0.333333、1e+16
    print(4.0)
    print(0.1)
    print(1.0 / 3.0)
    print(0.1 + 0.2)
    print(1e16, 1e-5)
    print(2.5, -0.0, 100.0)


def rounding():
    print(int(3.7), int(-3.7), int(0.0))
    print(abs(-4), abs(4), abs(-4.5))
    print(min(3, 7), max(3, 7), min(-1.5, 2.0), max(-1.5, 2.0))
    # 串上的挑与排：一格一个字符
    print(min("abc"), max("abc"), sorted("bca"), sorted("cba", reverse=True))


def bits():
    print(6 & 3, 6 | 3, 6 ^ 3, ~6)
    print(1 << 10, 1024 >> 3)


def maths():
    print(math.sqrt(2.0))
    print(math.floor(2.7), math.ceil(2.1))
    print(math.hypot(3.0, 4.0))
    print(math.exp(0.0), math.log10(1000.0))


def compare_chain(a: int, b: int, c: int) -> str:
    if a < b < c:
        return "up"
    if a > b > c:
        return "down"
    return "mixed"


def main():
    floor_div_table()
    powers()
    floats()
    rounding()
    bits()
    maths()
    bool_as_int()
    divmods()
    print(compare_chain(1, 2, 3), compare_chain(3, 2, 1), compare_chain(1, 3, 2))


main()

# ---- min / max 里 int 与 real 混着来 -----------------------------------------
# 方言的三目两支必须同型，所以这一档**两边都装箱**（不能把 int 提到 real：python 的
# `max(3, 2.5)` 交的是 `3`，印 `3` 不是 `3.0` —— 提上去就印错数）。
# 还有一条：**平手时留左边那一格**（python 的 min/max 交的是"第一个最小/最大的"），
# 所以 `max(2, 2.0)` 是 `2`、`max(2.0, 2)` 是 `2.0` —— 比法要非严格。
print(max(3, 2.5), min(3, 2.5), max(2.5, 3), min(2.5, 3))
print(max(1, 2.5), min(1, 2.5), max(1, 2, 3.5), min(3, 1.5, 2))
print(max(2, 2.0), min(2, 2.0), max(2.0, 2), min(2.0, 2))
print(max(3, 2.5) + 1, str(max(3, 2.5)), max(3, 2.5) * 2)
# 同型那几档照旧（不装箱）
print(max(1, 2), min(1.5, 2.5), max("a", "b"), max([3, 1, 2]))

# ---- float(串) ----------------------------------------------------------------
# 取整交给宿主那份**正确取整**的解析器（方言新加的 `(sreal S)`：JS 的 `Number` /
# C 的 `strtod`），python 自己的宽容度写在 `ext/python/lib/num.py` 里：两头的 **Unicode
# 空白**、数字之间的**下划线**、`inf` / `infinity` / `nan` 那几种拼法（不分大小写、可带符号）。
# 末位见真章的那几个（0.1 / 17 位有效数字 / 次正规数）是这一格值钱的地方 ——
# 自己写十进制到二进制的取整会在那儿差一点。
print(float("1.5"), float("-2.25"), float("+3"), float(".5"), float("5."))
print(float("1e3"), float("1E-3"), float("-2.5e+2"), float("0.1"))
print(float("0.30000000000000004"), float("2.2250738585072014e-308"))
print(float("9007199254740993"), float("1.7976931348623157e308"))
print(float(" 2.5 "), float("1_000.5"), float("1_0e1_0"))
print(float("inf"), float("-Infinity"), float("NaN"), float("+INF"))
print(float("1.5") + float("2.5"), float(str(0.1)) == 0.1, float("3") == 3.0)

# ---- round(x, n) 走十进制那条路 -----------------------------------------------
# `round(2.675, 2)` 是 **2.67** 不是 2.68：2.675 在双精度里其实是 2.67499999999999982…，
# CPython 的两参 round 走十进制（`_Py_dg_dtoa`）。我们现在也走十进制 —— `sfix` 是
# C 的 `%.*f`（对精确的二进制值舍入）、新加的 `(sreal S)` 再按正确取整解析回来。
# 两条边界：`round(int, n)` **还是 int**（`round(5, 2)` 是 5 不是 5.0）；inf / nan 原样回。
print(round(2.675, 2), round(1.005, 2), round(0.125, 2), round(-2.675, 2))
print(round(5, 2), round(-3, 1), round(2.5, 0), round(3.14159, 3), round(0.0, 5))
print(round(1e300, 2), round(0.5), round(1.5), round(2.5), round(-1.5))

# **负的 n**：舍的位落在小数点左边，`sfix` 那条路用不上（它的精度只能 >= 0）。两档各一套：
# int 走整数算术（半数取偶看商的奇偶）—— **不许提到 double**，int64 超过 2^53 那一段会
# 静静答错；real 先按 10^k 缩小、走同一条十进制的路、再乘回来。
print(round(123.456, -1), round(123.456, -2), round(1250.0, -2), round(15.0, -1))
print(round(25.0, -1), round(-125.0, -1), round(0.4, -1), round(-0.4, -1))
print(round(125, -1), round(135, -1), round(-125, -1), round(-135, -1))
print(round(1234, -2), round(1250, -2), round(1350, -2), round(5, -1))
print(round(1234567890123456789, -1), round(999, -1), round(0, -3))

# ---- `math` 里那几格常量与那几格"不是一格 rmath"的函数 ------------------------
# `inf` / `nan` 方言里没有字面量：拿 `1e308 * 10` 与 `inf - inf` 算（与 `lib/num.py` 一条）。
print(math.pi, math.e, math.tau, math.inf, -math.inf, math.nan)
# `isnan` / `isinf` / `isfinite` 按 `x != x` 与 `x - x != 0` 落，不必有新算子
print(math.isnan(math.nan), math.isnan(1.0), math.isinf(math.inf), math.isfinite(1.0))
# `trunc` 是向零取整（交 int）；`log(x, base)` 是换底；`degrees` / `radians` 乘一格常量
print(math.trunc(2.7), math.trunc(-2.7), math.log(8, 2), math.log(math.e))
print(math.degrees(math.pi), math.radians(180), math.log10(100), math.hypot(3, 4))
# `copysign` 的 **`-0.0` 那一档要看文本**（`b < 0` 答不出来 —— python 交 -2.0）
print(math.copysign(2, -1), math.copysign(2, -0.0), math.copysign(-3, 1))
# `gcd` / `factorial` 是整数上的循环 —— 写在 `lib/num.py` 里，adapter 自己要一格实例
print(math.gcd(12, 18), math.gcd(-12, 18), math.gcd(0, 0), math.factorial(5), math.factorial(0))
