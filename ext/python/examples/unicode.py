# ext/python/examples/unicode.py —— 串按**码点**走（`len` / 下标 / 切片 / `find`）
#
# 我们这一层的串是 UTF-8 字节，python 的 `str` 是码点序列 —— 从前"用户看得见的下标与长度"
# 全按字节算，于是非 ASCII 上静静答错（`len("héllo wörld")` 答 13、`s[1]` 切出半个字符、
# `find("ö")` 回字节下标 8）。现在 python 那一层的这几格走方言新加的 UTF-8 算术
# （`(scplen)` / `(scpsub)` / `(scpfind)`），这一份就是那一刀的判据。
#
# **还没接的两格**（明说，不在这一份里）：
#   * `.upper()` / `.lower()` 对非 ASCII 不动 —— 那要 unicode 的大小写表，是借
#     `Objects/unicodeobject.c` 的事（这一族不是 UTF-8 算术）；
#   * `ord()` / `chr()` 对非 ASCII 报话 —— 那一格是 UTF-8 的编解码，该我们做，下一刀。


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


main()
