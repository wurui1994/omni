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


def _str_repr(s):
    # 串的 `repr()` —— 照 CPython 的 `unicode_repr`。两条容易写错的：
    #   * **引号是挑出来的**：里头有 `'` 而没有 `"` 时用双引号包（那时 `'` 不转义），
    #     别的一律单引号。`repr("a'b")` 是 `"a'b"`，这一层从前答的是 `'a'b'`。
    #   * `\\` 与"包它那一格引号"要转义；`\n` / `\r` / `\t` 有自己的写法，别的 ASCII
    #     控制字符走 `\xHH`（小写十六进制、补到两位）。
    #
    # **明说的不足**：非 ASCII 的不可打印字符（`\u200b` 那一族）这一层照原样放过 ——
    # python 那边转成 `\u200b`。要接得先有 `isprintable` 那张表（见 SPEC）。
    q = "'"
    if "'" in s and '"' not in s:
        q = '"'
    out = q
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        o = ord(c)
        if c == "\\":
            out = out + "\\\\"
        elif c == q:
            out = out + "\\" + c
        elif c == "\n":
            out = out + "\\n"
        elif c == "\r":
            out = out + "\\r"
        elif c == "\t":
            out = out + "\\t"
        elif o < 32 or o == 127:
            d = "0123456789abcdef"
            out = out + "\\x" + d[o // 16] + d[o % 16]
        else:
            out = out + c
        i = i + 1
    return out + q


def _str_group3(s, sep):
    # 千分位（格式说明里的 `,` 与 `_`）—— **只动整数那一段**：符号留在最前头，
    # 小数点及其后面原样。收的是**已经排好的那串文本**，所以这一格与数的类型无关。
    i = 0
    if len(s) > 0:
        if s[0] == "-" or s[0] == "+" or s[0] == " ":
            i = 1
    j = i
    n = len(s)
    while j < n:
        c = s[j]
        if c < "0" or c > "9":
            break
        j = j + 1
    digits = s[i:j]
    out = ""
    k = len(digits)
    while k > 3:
        out = sep + digits[k - 3:k] + out
        k = k - 3
    return s[:i] + digits[:k] + out + s[j:]


def _str_zgroup(s, sep, width):
    # 千分位与零填充**同时**给（`f"{1234567:012,}"`）—— python 那时"补的零也要分组"，
    # 所以不能先补零再分组、也不能分组完一把补零。收的是**已经分好组的**那串文本，
    # 一位一位往左加零，最左那段满 3 位就先加一格分隔符。
    # 量出来的一格边界：还差 1 格宽而最左段已满 3 位时 python **仍然**加 "0" 加分隔符
    # （`format(123456, "08,")` 交 `0,123,456` —— 9 个字符，比要的宽度还宽一格）。
    i = 0
    if len(s) > 0:
        if s[0] == "-" or s[0] == "+" or s[0] == " ":
            i = 1
    sign = s[:i]
    body = s[i:]
    need = width - len(sign) - len(body)
    while need > 0:
        k = 0
        n = len(body)
        while k < n:
            c = body[k]
            if c < "0" or c > "9":
                break
            k = k + 1
        if k == 3:
            body = "0" + sep + body
            need = need - 2
        else:
            body = "0" + body
            need = need - 1
    return sign + body
