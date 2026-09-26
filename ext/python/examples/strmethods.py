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
#   - **`str.center()` 与 f-string 的 `:^` 摆法不一样**：`'ab'.center(7,'*')` 是
#     `***ab**`（多的在左），`f"{'ab':*^7}"` 是 `**ab***`（多的在右）。
#
# 明说还没接的：`.split()` 不带分隔符、`.split(sep, maxsplit)`、`.partition()`、
# `.format()`、`.encode()`、`.count(sub, start, end)` 那一族带范围的。


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

    # 补宽度
    print("ab".center(6) + "|", "ab".center(7, "*") + "|", "abcdef".center(3) + "|")
    print("ab".ljust(5, ".") + "|", "ab".rjust(5, ".") + "|", "7".zfill(3))

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


main()
