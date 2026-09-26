# ext/python/lib/str.py —— str 上那几格方法，**用 python 自己写**
#
# 为什么在这儿而不在 adapter 里：这几格是**库函数**，不是语法。它们只在串与整数上算，
# 一个字都不需要编译期的类型信息 —— 写成 python，由这条链自己编（类型推断 + 单态化
# 与用户代码走同一趟），三条腿自然都有。写在 adapter 里等于把库塞进语法层，而且是
# 每加一格方法就往那条 322 行的 `if` 链上再挂一条。
#
# 这一份的口径：**照 CPython 的 `Objects/unicodeobject.c`**（不是照文档猜）。
# 谁要用哪一格由 adapter 的那张名字表决定（`ext/python/adapter/pylib.js`）；
# **没人用的一格都不发** —— 单态化是按调用点收实例的，一格实例都没有的函数不进产物。
#
# 这里头只许用这门语言**已经接住**的写法（不然会绕回来咬自己）：
# 串的下标与切片、`len`、`+`、`*`、比较、`while` / `if` / `return`、字面量默认值。
# 特别不许在这儿用**这一份自己正在实现的那格方法**。


def _str_ljust(s, w, fill=" "):
    return s + fill * (w - len(s))


def _str_rjust(s, w, fill=" "):
    return fill * (w - len(s)) + s


def _str_zfill(s, w):
    # 与 `rjust(w, "0")` **不是一回事**：开头那一格符号要留在最前头
    # （`"-7".zfill(4)` 是 `-007`，不是 `00-7`）。
    pad = "0" * (w - len(s))
    if len(s) > 0:
        if s[0] == "+" or s[0] == "-":
            return s[0] + pad + s[1:]
    return pad + s


def _str_center(s, w, fill=" "):
    # CPython 的原式（`unicodeobject.c` 的 `unicode_center_impl`）：
    #   marg = width - len(s); left = marg / 2 + (marg & width & 1)
    # 也就是说**多出来那一格填在哪边要看 marg 与 width 的奇偶**，
    # 不是一句"多的在左边"：`"ab".center(7,"*")` 是 `***ab**`，
    # 而 `"a".center(6,"*")` 是 `**a***`。
    marg = w - len(s)
    left = marg // 2
    if marg % 2 == 1:
        if w % 2 == 1:
            left = left + 1
    return fill * left + s + fill * (marg - left)
