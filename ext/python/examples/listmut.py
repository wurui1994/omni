"""表上那几格"找"与"改"，以及 `in` 落在表上。

方言里表那一族只有 `anew` / `aget` / `aset` / `apush` / `alen` / `apop` ——
`in` / `index` / `count` / `reverse` / `extend` / `clear` / `insert` / `remove` / `pop(i)`
全是**现场发一趟循环**（`ext/python/adapter/builtins.js`），三条腿一行没改就通。

改原表的那几格在 python 里交 `None`，所以**只当语句用**（当表达式用会当场说清）。
"""

xs = [1, 2, 3]

print(2 in xs, 9 in xs)
print(xs.index(2), xs.count(2))
print([1, 1, 2].count(1))

xs.reverse()
print(xs)

xs.extend([7, 8])
print(xs)

xs.insert(0, 0)
print(xs)
xs.insert(2, 99)
print(xs)
xs.insert(100, 5)      # 下标超了就是追加（python 的规矩）
print(xs)

xs.remove(99)
print(xs)

xs.pop()
print(xs)
xs.pop(0)
print(xs)

xs.clear()
print(xs, len(xs))

ws = ["a", "bb", "a"]
print("bb" in ws, "z" in ws)
print(ws.index("a"), ws.count("a"))

# 异质的表也走同一条（比法按标签分派）
zs = [1, "two", 3.5]
print("two" in zs, 3.5 in zs, 9 in zs)
zs.append(None)
print(zs)
zs.reverse()
print(zs)

# 串上补宽度那三格
print("hi".ljust(5) + "|")
print("hi".rjust(5) + "|")
print("hi".ljust(5, ".") + "|")
print("7".zfill(3))
print("abcdef".zfill(3))
