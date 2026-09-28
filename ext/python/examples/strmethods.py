# ext/python/examples/strmethods.py —— 串上剩下那一批方法，加上 .copy()
#
# 方言的串那一族只有五格算子（`slen` / `sfind` / `ssub` / `srep` / `supper` / `slower`
# / `sbase` / `sfix` …），所以这一批全是**现场发一趟循环**或者拿那几格拼出来的 ——
# 一个新算子都没加。
#
# **只动 ASCII**这一条与 `.upper()` / `.lower()` 同：非 ASCII 的大小写与字母判断要借
# `Objects/unicodeobject.c` 的映射表，在那之前只有 ASCII 那一档是对的。
#
# 拿 python3 比出来的几条口径（照着文档写会写错的地方）：
#   - `.title()` 的边界是"**前一格不是字母**"，数字也算边界 —— `"a1b".title()` 是 `A1B`。
#   - `.isupper()` 是"**有至少一格大写、而且没有小写**"，不是"每一格都大写" ——
#     所以 `"A1".isupper()` 是 True，而 `"1".isupper()` 是 False。
#     `.isalpha()` 那一族反过来：每一格都要在类里，而且串非空。
#   - **`str.center()` 与 f-string 的 `:^` 摆法不一样**，而且 center 那一格**不是**
#     一句"多的在左边"：CPython 的原式是 `left = marg // 2 + (marg & width & 1)`，
#     也就是要看 marg 与 width 的奇偶 —— `'ab'.center(7,'*')` 是 `***ab**`（多的在左），
#     可 `'a'.center(6,'*')` 是 `**a***`（多的在右）。f-string 的 `:^` 一律多的在右。
#     从前这儿按"多的在左"写，六种里错三种（量出来的）。现在这一格在 `lib/str.py` 里。
#   - `.partition()` 找不到分隔符时**两边站的位置不一样**：`partition` 交 `(s, '', '')`，
#     `rpartition` 交 `('', '', s)` —— 不是对称的。
#   - `.count()` 数的是**不重叠**的那几段（`"aaa".count("aa")` 是 1），而空的那一段数的是
#     "位置数"（`"abc".count("")` 是 4）。
#   - `.expandtabs(n)` 的制表位是**按列**算的（补到下一个 n 的整数倍），列数换行归零；
#     `.splitlines()` 与 `.split("\n")` **不是一回事** —— 末尾那个换行不留空段。
#
# 明说还没接的：`.encode()`；`.splitlines()` 只认 `\n` 与 `\r`（python 还认 `\v` / `\f` /
# U+2028 那一批）。


def main():
    # 大小写那三格
    print("hello world".title(), "a-b c".title(), "a1b".title())
    print("hello".capitalize(), "HELLO".capitalize(), "".capitalize() + "|")
    print("AbC".swapcase(), "hello World".swapcase())

    # strip 那三格：不带实参去空白，带实参去那几个字符
    print("  x  ".strip() + "|", "xxaxx".strip("x") + "|")
    print("ab".lstrip("a") + "|", "ab".rstrip("b") + "|")
    print("  a b  ".strip(), "--a--".strip("-"), "xyaxy".strip("xy"))

    # 判类别：每一格都要在类里，而且串非空
    print("abc".isalpha(), "ab1".isalpha(), "".isalpha())
    print("123".isdigit(), "12a".isdigit(), "".isdigit())
    print("a1".isalnum(), "a-1".isalnum(), "".isalnum())
    print("  ".isspace(), " a ".isspace(), "".isspace())
    # 大小写那两格是另一套规矩（有一格、且没有反着的）
    print("ABC".isupper(), "A1".isupper(), "Ab".isupper(), "".isupper(), "1".isupper())
    print("abc".islower(), "a1".islower(), "aB".islower(), "".islower())

    # 找：rfind 从后往前；index / rindex 找不到就报（这一份只走找得到的那条）
    print("abcabc".rfind("b"), "abc".rfind("z"), "abc".find("b"))
    print("abcabc".index("b"), "abcabc".rindex("b"))
    print("abcabc".rfind("bc"), "abcabc".index("bc"))

    # 切头去尾：没有那一段就原样
    print("abc".removeprefix("a"), "abc".removesuffix("c"))
    print("abc".removeprefix("z"), "abc".removesuffix("z"))

    # 补宽度（这四格在 `ext/python/lib/str.py` 里 —— 库函数，不是语法）
    print("ab".center(6) + "|", "ab".center(7, "*") + "|", "abcdef".center(3) + "|")
    print("ab".ljust(5, ".") + "|", "ab".rjust(5, ".") + "|", "7".zfill(3))
    # center 那一格的奇偶（从前六种里错三种）
    print("a".center(6, "*"), "a".center(4, "*"), "abc".center(6, "-"), "ab".center(5, "-"))
    print(f"{'ab':*^7}", f"{'a':*^6}")
    # **宽度不必是字面量了**：库函数收的是一格值（从前 `.center(w)` 要求 w 写成字面量）
    w = 7
    for s in ["a", "bb", "ccc"]:
        print(s.center(w, ".") + "|", s.ljust(w - 2, "_") + "|", s.zfill(w - 3))

    # .copy()：浅抄一份，动新的不碰旧的
    xs = [1, 2, 3]
    ys = xs.copy()
    ys.append(4)
    print(xs, ys)
    d = {"a": 1}
    e = d.copy()
    e["b"] = 2
    print(d, e)

    # 串里走一遍的那几格接着用
    words = "a,bb,ccc".split(",")
    print(words, [w.upper() for w in words], "-".join(words))

    # 切三段：分隔符前、分隔符本身、分隔符后（找不到时两边站的位置不一样）
    print("a,b,c".partition(","), "a,b,c".rpartition(","))
    print("abc".partition("-"), "abc".rpartition("-"))
    print("a=".partition("="), "=b".partition("="))
    print("k:v".partition(":")[0], "k:v".partition(":")[2])

    # 数段：不重叠；空的那一段数位置
    print("abcabc".count("bc"), "aaa".count("aa"), "abc".count(""))
    print("abcabc".count("bc", 2), "abcabc".count("b", 0, 3), "abcabc".count("c", -2))

    # 换：只换前几处
    print("a-b-c".replace("-", "+"), "a-b-c".replace("-", "+", 1))
    print("a-b-c".replace("-", "+", 0), "a-b-c".replace("-", "+", 9))

    # 不带分隔符地切：按连续空白，首尾的空段不算
    print("  a b  c ".split(), "".split(), " ".split())
    print("a b  c".split(None, 1), "a b c".split(None, 0))

    # 制表位是**按列**算的（不是"一个 tab 换 n 个空格"），换行归零
    print("a\tb".expandtabs(4) + "|", "ab\tc".expandtabs(4) + "|")
    print("abcd\te".expandtabs(4) + "|", "\t".expandtabs(4) + "|")
    print("a\tb".expandtabs() + "|", "a\nb\tc".expandtabs(4) + "|")

    # 按行切：与 .split("\n") 不是一回事（末尾那个换行不留空段，\r\n 算一个分隔）
    print("a\nb".splitlines(), "a\nb\n".splitlines())
    print("".splitlines(), "\n".splitlines(), "a\n\nb".splitlines())
    print("a\r\nb".splitlines(), "a\rb".splitlines())
    print("a\n".splitlines(), "a\n".split("\n"))


main()

# ---- .zfill 的符号 / .rsplit / .casefold -------------------------------------
# **`.zfill(w)` 不是 `rjust(w, "0")`**：开头那一格符号（`+` / `-`）要留在最前头。
# 量出来的原话：`"-7".zfill(4)` 从前答 `00-7`，python 是 `-007`。
print("7".zfill(3), "-7".zfill(4), "+7".zfill(4), "abc".zfill(5))
print("-7".zfill(2), "".zfill(3), "-".zfill(3), "12345".zfill(3))

# **`.rsplit(sep, n)` 不是"先 split 再挑后几段"**：maxsplit 是从右数那么多次，
# 段数一样但分界不同。
print("a-b-c".rsplit("-"), "a-b-c".rsplit("-", 1), "a-b-c".split("-", 1))
print("a-b-c".rsplit("-", 0), "a-b-c".rsplit("-", 9), "abc".rsplit("-", 1))
print("a--b".rsplit("-", 1), "-a-".rsplit("-", 1), "  x y  ".rsplit())

# `.casefold()` —— **ASCII 那一档就是 `.lower()`**（真正的 casefold 与 lower 只在
# 非 ASCII 上分家，而非 ASCII 的大小写这一层本来就明说没接）。
print("Hello".casefold(), "Hello".casefold() == "Hello".lower(), "".casefold())

# ---- .replace("") 与格式说明的三格 -------------------------------------------
# **空模式**在 python 里有定义：每一格字符前面插一处、末尾再插一处（从前我们当场报）。
print("abc".replace("", "-"), "".replace("", "-"), "abc".replace("", "-", 2), "abc".replace("", "-", 0))
# f-string 的 `#`（前缀，负数时符号在前缀之前）、`e` / `E`、`g` / `G`。
print(f"{255:#x} {255:#X} {8:#o} {5:#b} {-255:#x}")
print(f"{12345.6789:e} {12345.6789:E} {0.00001234:g} {0.00001234:G} {1.5:.2e}")

# ---- 串的 repr：引号是挑出来的，里头要转义 ------------------------------------
# 量出来的原话：`repr("a'b")` 从前答 `'a'b'`（三个单引号，连 python 自己都读不回来）。
# 规矩照 CPython 的 `unicode_repr`：里头有 `'` 而没有 `"` 时用双引号包（那时 `'` 不转义），
# 别的一律单引号，里头的 `'` 写成 `\'`。这一格在 `lib/str.py` 的 `_str_repr` 里。
print(repr("a'b"), repr('x"y'), repr("q'\"w"), repr("ab"), repr(""))
# `\\` 与三格有名字的控制字符；别的 ASCII 控制字符是 `\xHH`（小写、补到两位）。
print(repr("a\\b"), repr("t\n"), repr("r\r"), repr("t\tb"), repr(chr(7)), repr(chr(127)))
# **容器里的元素走 repr** —— 源码里一个 `repr` 字都没有，那一格库函数是 adapter
# 自己要出来的（`C.requireFn`）。
print(["a'b", 'x"y', "t\n"], {"k'": "v\n"}, ("a'b", 1))
# f-string 的 `!r` 与 `.format()` 的 `{!r}` 走同一条路。
s = "a'b"
print(f"{s!r}", "{!r}".format(s))

# `.format()` 的**按名字取**（`{k}` + 命名实参）—— 名字在编译期就有，与 `{0}` 同一条路。
print("{k}".format(k=3), "{a}{b}".format(a=1, b=2), "{0}{k}".format(9, k=8))
print("{n:>5}|".format(n=42), "{s!r}".format(s="a'b"), "{x:.2f}".format(x=3.14159))

# ---- 那对可选的 start / end ---------------------------------------------------
# `find` / `rfind` / `index` / `rindex` / `startswith` / `endswith` / `count` 都收 ——
# python 的口径是"在 `s[i:j]` 上做"（下标可以是负的、也可以越界，两头夹到 `[0, len]`）。
# **交出来的下标是相对整串的**：`"aXbX".find("X", 2)` 是 3 不是 1（段里的下标要加回起点）。
t = "hello world hello"
print(t.find("hello", 1), t.find("l", 4, 6), t.rfind("hello"), t.index("world", 3))
print(t.find("z", 2), t.find("hello", -5), t.rfind("l", 0, 5), t.find("", 3))
print(t.startswith("world", 6), t.startswith("hello", 1), t.endswith("hello", 0, 5))
print(t.count("l", 3), t.count("l", 3, 6), t.count("hello", 1), t.count("l", -4))
# 表上的 `.index()` 也收（`xs.index(2, 2)`）
xs = [1, 2, 3, 2]
print(xs.index(2), xs.index(2, 2), xs.index(2, -2), xs.count(2))
