# ext/python/lib/num.py —— 数与串之间那几格（python 自己的宽容度）
#
# 这一份只做**python 的规矩**，真正的取整交给方言的 `(sreal S)` —— 那一格三条腿分别落到
# JS 的 `Number` 与 C 的 `strtod`，都是**正确取整**的解析器。自己写十进制到二进制的
# 取整会在末位上差一点，那正是"库函数不自己写"这条路线要避开的（账在 SPEC §一之二）。
#
# python 的 `float(s)` 比方言那一格宽容三处，这一份补的就是这三处：
#   1. 两头允许 **Unicode 空白**（`" 1.5\u00a0"`）—— 走 `lib/ucase.py` 的 `_str_strip`；
#   2. 数字之间允许**下划线**（`"1_000.5"`）—— 摘掉；两边不是数字的下划线**留着**，
#      让 `(sreal …)` 自己去报（这样"1__0" 与 "_1" 照旧不收，与 python 一致）；
#   3. `inf` / `infinity` / `nan` 那几种拼法（不分大小写、可带符号）。
#
# **还没接的一格**（明说）：python 的 `float("１.５")` 收全角数字（Unicode 十进制数字都收），
# 我们这一格只收 ASCII 那十个 —— 真喂全角进来是 `(sreal …)` 当场报，不是静静答错。

# `_sreal(s)` 是 adapter 认的一格内建：直通方言的 `(sreal S)`。


def _float_inf():
    # 方言里没有 `inf` 字面量：拿最大的有限值再乘一趟（IEEE 的规矩，三条腿一致）。
    big = 1e308
    return big * 10.0


def _math_gcd(a, b):
    # `math.gcd` —— 辗转相除。python 那边收负数（`gcd(-12, 18)` 是 6），两个 0 答 0。
    x = a
    y = b
    if x < 0:
        x = 0 - x
    if y < 0:
        y = 0 - y
    while y != 0:
        t = x % y
        x = y
        y = t
    return x


def _math_factorial(n):
    # `math.factorial` —— python 那边负数是 ValueError；库函数这一层没有"停下来"那格算子，
    # 所以负数答 0（**明说的不足**，不是静静答错：0 不是任何 n 的阶乘）。
    if n < 0:
        return 0
    out = 1
    i = 2
    while i <= n:
        out = out * i
        i = i + 1
    return out


def _float_nan():
    x = _float_inf()
    return x - x


def _float_of_str(s):
    t = _str_strip(s)
    low = _str_lower(t)
    if low == "inf" or low == "+inf" or low == "infinity" or low == "+infinity":
        return _float_inf()
    if low == "-inf" or low == "-infinity":
        return 0.0 - _float_inf()
    if low == "nan" or low == "+nan" or low == "-nan":
        return _float_nan()
    out = ""
    i = 0
    n = len(t)
    while i < n:
        c = t[i]
        keep = True
        if c == "_":
            if i > 0 and i + 1 < n:
                if _str_isdecimal(t[i - 1:i]) and _str_isdecimal(t[i + 1:i + 2]):
                    keep = False
        if keep:
            out = out + c
        i = i + 1
    return _sreal(out)
