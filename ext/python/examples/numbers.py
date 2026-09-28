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
