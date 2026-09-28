# ext/python/lib/ucase.py —— 大小写那一族的**逻辑**（表是数据，在 ext/python/rt/ucase.tab）
#
# 路线在 `ext/python/SPEC.md` §一 第 29 条的**路 3**：表是数据、逻辑写一遍。这一份是
# 那个"写一遍"——三条腿（解释器 / JS / 原生）跑的是同一份 python 源码，所以不会分叉。
#
# 五格内建是 adapter 认的（`ext/python/adapter/ucase.js` 那张表），落到刚补上的
# `(mload …)`：`_uidx1(i)` / `_uidx2(i)` 查两级索引、`_urecf(r)` 取标志、
# `_urecn(r, w)` 取那一格映射有几个码点、`_urecv(r, w, k)` 取第 k 格。
# **偏移量不写在这儿**：那几个数由 `ucase.tab` 的元信息说，adapter 折进 `mload` 的地址里。
#
# 这里头只许用这门语言**已经接住**的写法（与 `lib/str.py` 同一条纪律）：
# 串的下标、`len`、`ord`、`chr`、`+`、比较、位运算、`while` / `if` / `return`、字面量默认值。
# 特别不许用**这一份自己正在实现的那几格方法**（`.upper()` / `.lower()` / `.casefold()`）。
#
# 口径：照本机 python3（`gen-ucase.js` 问的就是它），不是照 Unicode 标准的文字猜。


def _ucase_rec(cp):
    # 两级索引：一级按 64 格一块、二级是去重之后的块。
    return _uidx2(_uidx1(cp >> 6) * 64 + (cp & 63))


def _ucase_map(cp, w):
    # 第 w 格映射（0 upper / 1 lower / 2 title / 3 casefold）。
    # 单格的存的是**差值**（`a` -> `A` 与 `b` -> `B` 是同一格记录），多格的存绝对码点。
    r = _ucase_rec(cp)
    n = _urecn(r, w)
    if n == 1:
        return chr(cp + _urecv(r, w, 0))
    out = ""
    k = 0
    while k < n:
        out = out + chr(_urecv(r, w, k))
        k = k + 1
    return out


def _ucase_cased(cp):
    # "后随算不算 cased"那一位（第 8 位）。
    return (_urecf(_ucase_rec(cp)) >> 8) & 1 == 1


def _ucase_ignorable(cp):
    # "算不算 case-ignorable"那一位（第 9 位）。
    return (_urecf(_ucase_rec(cp)) >> 9) & 1 == 1


def _ucase_final_sigma(s, i, n):
    # 尾位 sigma（CPython `unicodeobject.c` 的 `handle_capital_sigma`）：
    # **前面**跳过 case-ignorable 之后有 cased，**后面**跳过 case-ignorable 之后没有 ——
    # 那这一格 `Σ` 小写成 `ς`，否则是 `σ`。`casefold()` **不走这一条**（一律 `σ`）。
    before = False
    k = i - 1
    while k >= 0:
        cp = ord(s[k])
        if _ucase_ignorable(cp):
            k = k - 1
        else:
            before = _ucase_cased(cp)
            k = -1
    if not before:
        return "\u03c3"
    k = i + 1
    while k < n:
        cp = ord(s[k])
        if _ucase_ignorable(cp):
            k = k + 1
        elif _ucase_cased(cp):
            return "\u03c3"
        else:
            k = n
    return "\u03c2"


def _str_upper(s):
    out = ""
    i = 0
    n = len(s)
    while i < n:
        out = out + _ucase_map(ord(s[i]), 0)
        i = i + 1
    return out


def _str_lower(s):
    out = ""
    i = 0
    n = len(s)
    while i < n:
        cp = ord(s[i])
        if cp == 931:
            out = out + _ucase_final_sigma(s, i, n)
        else:
            out = out + _ucase_map(cp, 1)
        i = i + 1
    return out


def _str_casefold(s):
    out = ""
    i = 0
    n = len(s)
    while i < n:
        out = out + _ucase_map(ord(s[i]), 3)
        i = i + 1
    return out
