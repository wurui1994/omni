# ext/python/examples/unicode.py —— 串按**码点**走（`len` / 下标 / 切片 / `find`）
#
# 我们这一层的串是 UTF-8 字节，python 的 `str` 是码点序列 —— 从前"用户看得见的下标与长度"
# 全按字节算，于是非 ASCII 上静静答错（`len("héllo wörld")` 答 13、`s[1]` 切出半个字符、
# `find("ö")` 回字节下标 8）。现在 python 那一层的这几格走方言新加的 UTF-8 算术
# （`(scplen)` / `(scpsub)` / `(scpfind)`），这一份就是那一刀的判据。
#
# **大小写那一族这一刀接上了**（见下面第十段）：逻辑在 `ext/python/lib/ucase.py`、
# 表在 `ext/python/rt/ucase.tab`（从本机 python3 生成的 292 份记录 + 两级索引），
# 三条腿跑的是同一份 python 源码。整张表的判据是 `npm run py:ucase-sweep`
# （1112064 个码点 × upper / lower / casefold 与 python3 逐字节相同）。
#   （`ord()` / `chr()` 那一格更早就接上了：见第九段。）


def main():
    s = "héllo wörld"
    # 一、长度按码点（不是 13 个字节）
    print(len(s))
    print(len("中文字符串"), len("🐍"), len(""))

    # 二、下标与负下标：取到的是**整个字符**
    print(s[0], s[1], s[6], s[-1], s[-4])
    e = "中文字符串"
    print(e[0], e[2], e[-1])

    # 三、切片：不会切在字符中间，越界照 python 那样夹
    print(s[1:5], s[:3], s[-4:], s[:], s[5:2], s[0:100])
    print(e[1:3], e[:2], e[-2:])

    # 四、find / index / rfind / count / in：位置也按码点
    print(s.find("ö"), s.find("w"), s.find("zz"))
    print(s.index("ö"), s.rfind("l"), s.count("l"), s.count("ö"))
    print("ö" in s, "zz" in s, s.startswith("hé"), s.endswith("ld"))
    print(e.find("字符"), e.rfind("字"))

    # 五、切分与拼接：切出来的每一格都是完整字符
    print(s.split())
    print("ö".join(["a", "b", "c"]))
    print(s.replace("ö", "o"), s.replace("é", "e"))
    print("-".join(["ä", "ö", "ü"]))

    # 六、宽度按码点（`center` / `ljust` / `rjust` 补到几个**字符**）
    print("[" + "äö".center(6, "*") + "]")
    print("[" + "äö".ljust(5, ".") + "]", "[" + "äö".rjust(5, ".") + "]")

    # 七、一格一格取，拼回去要与原串相同
    out = ""
    for i in range(len(s)):
        out = out + s[i]
    print(out == s, out)

    # 八、比较与排序（UTF-8 的字节序就是码点序 —— 这一档本来就对，别弄坏）
    print("abc" < "abd", "Z" < "a", "é" > "e")
    print(sorted(["banana", "Äpfel", "cherry"]))

    # 九、`ord` / `chr`：一格字符与它的码点之间（UTF-8 的编解码，不是 unicode 表）
    print(ord("A"), ord("é"), ord("中"), ord("🐍"))
    print(chr(65), chr(233), chr(20013), chr(128013))
    print(ord(chr(128013)), chr(ord("ö")))
    print("".join([chr(ord(c)) for c in s]) == s)

    # 十、大小写：**查表那一份**（`ext/python/lib/ucase.py` + `ext/python/rt/ucase.tab`）
    # 这一段从前是"当场报还没接"（方言的 supper/slower 只动 A-Z）。四类要各有一格：
    #   * 长度会变的（ß -> SS、ﬃ -> FFI、İ 的小写是 i + 点）；
    #   * 尾位 sigma（`ΟΔΟΣ` 的小写是 `οδος`，词中的是 `σ`）；
    #   * casefold 与 lower **不是一回事**（ß 的 casefold 是 ss，尾位 sigma 一律 σ）；
    #   * ASCII 那一档照旧对。
    print("äöü".upper(), "ÄÖÜ".lower(), "Straße".upper())
    print("ﬃ".upper(), "İ".lower(), "ǅ".upper(), "ǅ".lower())
    print("ΟΔΟΣ".lower(), "ΣΟΦΟΣ".lower(), "Σ".lower(), "ΑΣΒ".lower())
    print("Groß".casefold(), "ΣΟΦΟΣ".casefold(), "ﬃ".casefold())
    # 尾位 sigma 那条规矩要**前后都看**：前面跳过可忽略的有没有 cased、后面有没有。
    # `.Σ` 前面是个句点（既不 cased 也不可忽略）-> `σ`；`αΣʲ` 后面那个 ʲ **既 cased
    # 又可忽略**，可忽略优先 -> 那个 Σ 算尾位 -> `ς`。这两格是探针写错时唯一会红的地方。
    print(".Σ".lower(), "αΣ.".lower(), "αΣ".lower(), "αΣʲ".lower(), "αΣa".lower())

    # 十一、`.title()` / `.capitalize()` / `.swapcase()` —— 同一张表、同一份逻辑
    #   * `.title()` 按**词边界**：上一格算不算 cased（`a'b` -> `A'B`，撇号不 cased）；
    #   * `.capitalize()` 只动头一格，**用的是首字母大写映射**（`ß` -> `Ss`、`ǅ` -> `ǅ`），
    #     其余一律小写（`abc def` -> `Abc def`，与 title 正相反）；
    #   * `.swapcase()` 大写换小写、小写换大写，**首字母大写那一档两边都不是**
    #     （`ǅa` -> `ǅA`），而换出来的小写照旧走尾位 sigma（`ΣΣ` -> `σς`）。
    print("hello wörld".title(), "a'b".title(), "3a".title(), "ǅa".title())
    print("ß".title(), "ﬃ".title(), "σΣ".title(), "ʲΣ".title())
    print("ß".capitalize(), "abc def".capitalize(), "ǅ".capitalize(), "σΣ".capitalize())
    print("ΣΣ".swapcase(), "ǅa".swapcase(), "İ".swapcase(), "Groß".swapcase())

    # 十二、分类那一族也走同一张表。两条容易写错的口径：
    #   * `isupper()` 不是"每一格都大写"，是"**有至少一格 cased，而且没有反过来的那一档**"
    #     —— 所以 `"A1"` 是 True、`"1"` 是 False、`"ǅA"` 是 False（ǅ 是首字母大写那一档）；
    #   * `isdigit` / `isdecimal` / `isnumeric` **是三张不同的表**：`½` 只有 isnumeric、
    #     `Ⅻ`（罗马数字）也只有 isnumeric 而且还是大写的。
    print("äöü".isalpha(), "½".isnumeric(), "½".isdigit(), "٣".isdigit(), "１２３".isdecimal())
    print("Ⅻ".isnumeric(), "Ⅻ".isupper(), "ǅA".isupper(), "A1".isupper(), "1".isupper())
    print("ß".islower(), "ʲ".islower(), "\u00a0".isspace(), "".isalpha(), "aA".islower())
    # `.istitle()` 是"**是不是首字母大写的写法**"：大写那一档前面不许也是 cased
    # （`"AB"` False）、小写那一档前面必须是 cased（`"aA"` False）、一格 cased 都没有
    # 也是 False（`"123"`）。`ǅ` 是首字母大写那一档，所以 `"ǅa"` 是 True。
    print("Abc Def".istitle(), "Abc def".istitle(), "AB".istitle(), "ǅa".istitle(), "123".istitle())

    # 十三、**空白也是 Unicode 的**：`.strip()` 那三格与不带分隔符的 `.split()` 认的是
    # 表里那一位（NBSP / EM SPACE / 全角空格都算）。从前只认 ASCII 那六个，静静少剥、少切。
    w = "\u00a0\u2003a b\u3000c"
    print(len(w.strip()), len(w.lstrip()), len(w.rstrip()), w.strip() == "a b\u3000c")
    print(w.split(), "a\u00a0b".split(), "   ".split(), "a-b".split("-"))
    print("xxaybxx".strip("x") + "|", " a ".lstrip() + "|", " a ".rstrip() + "|")
    print("abc".upper(), "ABC".lower(), "".upper(), "".lower(), "".casefold())
    print("héllo wörld".upper(), "HÉLLO WÖRLD".lower())


main()
