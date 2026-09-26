# ext/python/lib/str.py —— str 上那几格方法，**一格样品**（不再长）
#
# 路线在 `ext/python/SPEC.md` §一之二：**运行时整份借 CPython 的 C**，主路线是编到 C
# （JS 腿从同一份 C 出）。所以**库函数不一格一格自己写** —— 这一份不是"标准库的开头"，
# 它是机制的样品：库函数当**真函数**编（不是编译期铺开）、**没人用的一格不发**
# （单态化按调用点收实例）。这四格以后会换成"调借来的 `unicode_ljust` /
# `unicode_zfill` / `unicode_center`"。
#
# 这里头只许用这门语言**已经接住**的写法（不然会绕回来咬自己）：
# 串的下标与切片、`len`、`+`、`*`、比较、`while` / `if` / `return`、字面量默认值。
# 特别不许在这儿用**这一份自己正在实现的那格方法**。
# 模块级语句是不跑的（这一层只收 `def`），所以常量写成字面量摆在用它的那一处。
#
# 口径：**照 CPython 的 `Objects/unicodeobject.c`**，不是照文档猜。


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
