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
