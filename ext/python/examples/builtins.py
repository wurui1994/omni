"""走一遍容器的那几个内建与串方法 —— **现场发一趟循环**。

方言里没有"聚合"这一族算子（没有 sum / min / sorted / join / split），可它有
`while` / `aget` / `apush` / `sfind` / `ssub`。所以这几格全在 adapter 里落成一趟循环
（`ext/python/adapter/builtins.js`）—— 三条腿一行没改就通。

为什么不往方言里加：这几个是 **python 自己的规矩**（`sum([])` 是 `0`、
`"a,,b".split(",")` 的空段算一格、`.strip()` 去哪几个空白字符、`d.get(k)` 没有时交
`None`），不是汇聚层该知道的。
"""

xs = [3, 1, 4, 1, 5]

print(min(xs), max(xs), sum(xs))
print(min(3, 1, 2), max(3, 1, 2), min(2, 1))
print(sorted(xs))
print(sorted(["pear", "apple", "fig"]))
print(sum([1.5, 2.5]))

print(list(range(4)))
print(list(range(2, 6)))
print(list(range(6, 2, -1)))

print(any([False, False, True]), all([True, True]), all([True, False]))

print(",".join(["a", "b", "c"]))
print("-".join(["solo"]))
print("a,b,,c".split(","))
print("a".split(","))
print(",a,".split(","))

print("|" + "  x  ".strip() + "|")
print("|" + "  x  ".lstrip() + "|")
print("|" + "  x  ".rstrip() + "|")
print("|" + "\t\n x \n\t".strip() + "|")

print("abcabc".replace("b", "XY"))
print("aaa".replace("a", ""))
print("abc".replace("z", "!"))

print("abc".startswith("ab"), "abc".startswith("z"), "abc".startswith("abcd"))
print("abc".endswith("bc"), "abc".endswith("z"))

d = {"a": 1, "b": 2}
print(d.get("a"), d.get("z"))
print(d.get("z", 9), d.get("a", 9))
print(d.get("z") is None, d.get("a") is None)

names = {"n": "omni"}
print(names.get("n"), names.get("q", "(没有)"))

# 拼起来用：把一张表里的数排好、转成串、连起来
def show(vals):
    parts = []
    for v in sorted(vals):
        parts.append(str(v))
    return ",".join(parts)


print(show([3, 1, 2]))
print(show([2.5, 1.5]))

# `for i, v in enumerate(xs)` 与 `for a, b in zip(a, b)` —— 都落成一格下标循环
# （python 里它们交的是一串元组，而这一层没有元组；这两种写法不必先有元组这一档）
words = ["a", "b", "c"]
for i, w in enumerate(words):
    print(i, w)
for i, w in enumerate(words, 1):
    print(i, w)

nums = [10, 20]
for w, n in zip(words, nums):
    print(w, n)
for ch, n in zip("xyz", [1, 2, 3, 4]):
    print(ch, n)

# ---- pow / list(…) / dict(…) / .split(sep, maxsplit) --------------------------
print(pow(2, 3), pow(2.0, 3), pow(2, 0), pow(2, -1))

# `list(串)` 拆成一格一个字符；`list(字典)` 交键表；**`list(表)` 抄一份**
print(list("abc"), len(list("")))
copy_src = [1, 2]
copy_dst = list(copy_src)
copy_dst.append(3)
print(copy_src, copy_dst)
ages2 = {"a": 1, "b": 2}
print(list(ages2))

# `dict(一串两格的元组)`；键重了后一格盖前一格
print(dict([("a", 1), ("b", 2)]))
print(dict([("a", 1), ("a", 9)]))
print(dict(list(ages2.items())))

# `.split(sep, maxsplit)`：切够那么多次就把剩下的整段推进去
print("a,b,c".split(",", 1), "a,b,c".split(",", 0), "a,b,c".split(",", 5))
print("a::b".split(":", 1), "a,b".split(",", -1))

# ---- int(串) / int(串, 进制) --------------------------------------------------
# 这一格**不用借 CPython 的 C**：整数逐位乘加就是精确的（"最短往返"那种讲究是浮点才有的）。
# 两头的空白、`+` / `-`、数位之间的 `_` 都许；一位有效数字都没有就 ValueError。
print(int("42"), int("-42"), int("+42"), int("0"))
print(int("  7  "), int("1_000"), int("123456789012345"))
# 进制要写成字面量；前缀在进制对得上时吃掉，大小写都认
print(int("0x1f", 16), int("1f", 16), int("0XFF", 16), int("-ff", 16))
print(int("101", 2), int("0b101", 2), int("777", 8), int("0o17", 8))
print(int("z", 36), int("Z", 36), int("10", 36))
