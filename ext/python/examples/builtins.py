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
