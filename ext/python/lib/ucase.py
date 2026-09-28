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


def _ucase_cased_plain(cp):
    # **Cased 本身**（第 10 位，不带"不可忽略"那一条）。`.title()` 记"上一格算不算 cased"
    # 用的是这一位 —— CPython 的 `fix_title` 问的是 `_PyUnicode_IsCased`。
    # 与第 8 位的差别只在 ʲ 那一族（既 cased 又可忽略）身上。
    return (_urecf(_ucase_rec(cp)) >> 10) & 1 == 1


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


def _ucase_lower_at(s, i, n):
    # 第 i 格的小写 —— 尾位 sigma 那条规矩要看**整条串里的上下文**，所以按位置问。
    # `.title()` / `.capitalize()` / `.swapcase()` 里那几处小写也走这一格
    # （量出来的：`"ΣΣ".swapcase()` 是 `σς`、`"σΣ".title()` 是 `Σς`）。
    cp = ord(s[i])
    if cp == 931:
        return _ucase_final_sigma(s, i, n)
    return _ucase_map(cp, 1)


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
        out = out + _ucase_lower_at(s, i, n)
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


def _str_title(s):
    # 词首用**首字母大写映射**（第 2 格），词中用小写 —— "上一格算不算 cased"记在 prev 里
    # （CPython 的 `fix_title`）。所以 `"a'b".title()` 是 `A'B`（撇号不 cased，`b` 又起一个词）。
    out = ""
    i = 0
    n = len(s)
    prev = False
    while i < n:
        cp = ord(s[i])
        if prev:
            out = out + _ucase_lower_at(s, i, n)
        else:
            out = out + _ucase_map(cp, 2)
        prev = _ucase_cased_plain(cp)
        i = i + 1
    return out


def _str_capitalize(s):
    # 头一格走**首字母大写映射**（不是 upper：`"ǅ".capitalize()` 是 `ǅ`、`"ß"` 是 `Ss`），
    # 其余一律小写（`"abc def".capitalize()` 是 `Abc def` —— 与 `.title()` 正相反）。
    n = len(s)
    if n == 0:
        return s
    out = _ucase_map(ord(s[0]), 2)
    i = 1
    while i < n:
        out = out + _ucase_lower_at(s, i, n)
        i = i + 1
    return out


def _ucase_all(s, bit):
    # `isalpha` 那一族的共同形状：**空串是 False**，非空要求每一格都带那一位。
    n = len(s)
    if n == 0:
        return False
    i = 0
    while i < n:
        if (_urecf(_ucase_rec(ord(s[i]))) >> bit) & 1 == 0:
            return False
        i = i + 1
    return True


def _str_isalpha(s):
    return _ucase_all(s, 0)


def _str_isdigit(s):
    return _ucase_all(s, 1)


def _str_isdecimal(s):
    return _ucase_all(s, 2)


def _str_isnumeric(s):
    return _ucase_all(s, 3)


def _str_isalnum(s):
    return _ucase_all(s, 4)


def _str_isspace(s):
    return _ucase_all(s, 5)


def _str_isupper(s):
    # **不是"每一格都大写"**：口径是"有至少一格 cased，而且没有小写、没有首字母大写那一档"
    # （CPython 的 `unicode_isupper`）。所以 `"A1".isupper()` 是 True、`"1"` 是 False、
    # `"ǅA"` 是 False（ǅ 是首字母大写那一档）。
    # 首字母大写那一档 = cased 而且既不大写也不小写（Cased = Lower + Upper + Lt）。
    n = len(s)
    i = 0
    cased = False
    while i < n:
        f = _urecf(_ucase_rec(ord(s[i])))
        up = (f >> 6) & 1 == 1
        lo = (f >> 7) & 1 == 1
        ti = (not up) and (not lo) and ((f >> 10) & 1 == 1)
        if lo or ti:
            return False
        if up:
            cased = True
        i = i + 1
    return cased


def _str_islower(s):
    # 与 `_str_isupper` 对称。
    n = len(s)
    i = 0
    cased = False
    while i < n:
        f = _urecf(_ucase_rec(ord(s[i])))
        up = (f >> 6) & 1 == 1
        lo = (f >> 7) & 1 == 1
        ti = (not up) and (not lo) and ((f >> 10) & 1 == 1)
        if up or ti:
            return False
        if lo:
            cased = True
        i = i + 1
    return cased

def _str_istitle(s):
    # "是不是首字母大写的写法"（CPython 的 `unicode_istitle`）—— 逐格走一趟：
    # 大写/首字母大写那一档**前面不许也是 cased**（`"AA"` 是 False），
    # 小写那一档**前面必须是 cased**（`"aA"` 是 False），别的一格把"前面是 cased"清掉。
    # 一格 cased 都没有是 False（空串、`"123"`）。
    n = len(s)
    i = 0
    cased = False
    prev = False
    while i < n:
        f = _urecf(_ucase_rec(ord(s[i])))
        up = (f >> 6) & 1 == 1
        lo = (f >> 7) & 1 == 1
        ti = (not up) and (not lo) and ((f >> 10) & 1 == 1)
        if up or ti:
            if prev:
                return False
            prev = True
            cased = True
        elif lo:
            if not prev:
                return False
            prev = True
            cased = True
        else:
            prev = False
        i = i + 1
    return cased


def _ucase_isspace_cp(cp):
    # 表里那一位空白（python 的空白是 Unicode 的：NBSP / EM SPACE / 全角空格都算）。
    return (_urecf(_ucase_rec(cp)) >> 5) & 1 == 1


def _ucase_in_chars(chars, ch):
    i = 0
    n = len(chars)
    while i < n:
        if chars[i] == ch:
            return True
        i = i + 1
    return False


def _str_lstrip(s):
    # **不带 chars 那一档**：按表里的空白位剥。带 chars 的是另一格函数
    # （`_str_lstrip_chars`）—— 不合成一格的理由：合起来那格的 chars 形参在"没给"那一档
    # 是 dyn，而体里要 `len(chars)` / `chars[i]`，那一档当场报"len 作用在 dyn 上"。
    n = len(s)
    a = 0
    while a < n:
        if _ucase_isspace_cp(ord(s[a])):
            a = a + 1
        else:
            break
    return s[a:]


def _str_rstrip(s):
    b = len(s)
    while b > 0:
        if _ucase_isspace_cp(ord(s[b - 1])):
            b = b - 1
        else:
            break
    return s[:b]


def _str_strip(s):
    return _str_rstrip(_str_lstrip(s))


def _str_lstrip_chars(s, chars):
    n = len(s)
    a = 0
    while a < n:
        if _ucase_in_chars(chars, s[a]):
            a = a + 1
        else:
            break
    return s[a:]


def _str_rstrip_chars(s, chars):
    b = len(s)
    while b > 0:
        if _ucase_in_chars(chars, s[b - 1]):
            b = b - 1
        else:
            break
    return s[:b]


def _str_strip_chars(s, chars):
    return _str_rstrip_chars(_str_lstrip_chars(s, chars), chars)


def _str_swapcase(s):
    # 大写的换小写、小写的换大写，**别的一格不动**（`ǅ` 是首字母大写那一档，两边都不是，
    # 所以 `"ǅa".swapcase()` 是 `ǅA`）。
    out = ""
    i = 0
    n = len(s)
    while i < n:
        cp = ord(s[i])
        f = _urecf(_ucase_rec(cp))
        if (f >> 6) & 1 == 1:
            out = out + _ucase_lower_at(s, i, n)
        elif (f >> 7) & 1 == 1:
            out = out + _ucase_map(cp, 0)
        else:
            out = out + s[i]
        i = i + 1
    return out

def _str_split_ws(s):
    # `.split()` **不带分隔符**那一档：按连续空白切、两头的空段不算
    # （python 的空白是 Unicode 的 —— 从前只认 ASCII 那六个，静静少切）。
    # 带分隔符的 `.split(sep)` 是另一条规矩（空段算一格），照旧在 adapter 里。
    out = []
    n = len(s)
    i = 0
    while i < n:
        if _ucase_isspace_cp(ord(s[i])):
            i = i + 1
        else:
            j = i
            go = True
            while go and j < n:
                if _ucase_isspace_cp(ord(s[j])):
                    go = False
                else:
                    j = j + 1
            out.append(s[i:j])
            i = j
    return out
