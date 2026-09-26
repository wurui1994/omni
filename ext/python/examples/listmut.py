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

# 大小写：**只有 ASCII 那一档是对的**（方言的 supper / slower 只动 ASCII —— 那是四条腿
# 能是同一个函数的前提）。python 的这两个是 Unicode 的，所以非 ASCII 会答错：
# `"äöü".upper()` 我们交 `äöü`、`"Straße".upper()` 我们交 `STRAßE`。
# 真要对得上得借 `Objects/unicodeobject.c` 的大小写映射表 —— 所以这儿只钉 ASCII。
print("Hello, World! 123".lower())
print("Hello, World! 123".upper())
print("MiXeD".lower() == "mixed")
print("".lower(), "".upper(), len("".lower()))

# 切片赋值：**就地**换掉那一段，两边长度可以不一样。改的是那个对象本身 ——
# 所以别处拿着同一个句柄的要一起看见（下面 `alias` 那一格判的就是这条）。
sl = [1, 2, 3, 4]
sl[1:3] = [9]
print(sl)
sl2 = [1, 2, 3]
sl2[0:0] = [0]
print(sl2)
sl3 = [1, 2, 3]
sl3[1:] = [7, 8, 9]
print(sl3)
sl4 = [1, 2, 3]
sl4[:2] = []
print(sl4)
sl5 = [1, 2, 3]
alias = sl5
sl5[0:1] = [9]
print(sl5, alias)
sl6 = [1, 2, 3]
sl6[-1:] = [5, 6]
print(sl6)
# 两头都不越界；`b < a` 那一刀是"在 a 处插进去"
sl7 = [1, 2, 3]
sl7[2:1] = [8]
print(sl7)
sl8 = [1, 2, 3]
sl8[0:99] = [4]
print(sl8)

# `.pop()` / `.pop(i)` **当值用**（`v = xs.pop()`）。顺带钉一条会答错的：
# `print(xs.pop(), xs)` —— python 是**从左到右**把实参算完的，而这儿是把几段拼成一个
# 大表达式，段里的 block-expr 那几句会被提到整句最前头，于是后面那一段的转串跑在前面
# 那一段的副作用**之前**（原先答 `2 [1, 2]`）。现在实参按次序各落一格临时量。
pp = [1, 2]
print(pp.pop(), pp)
qq = [1, 2, 3]
got = qq.pop()
print(got, qq)
print(qq.pop(0), qq)
rr = [1, 2, 3]
print(rr.pop(-1), rr)

# ---- .insert 的负下标 ---------------------------------------------------------
# python 的 `insert(i, x)` 落在 `max(0, len + i)`（len 是**插之前**那个长度），
# 所以 `-1` 是"插在最后一格之前"。量出来的原话：`[9,3,8,1,2,7].insert(-1, 6)`
# 从前插到了最前头（负的一律夹成 0）。
ins = [9, 3, 8, 1, 2]
ins.insert(0, 0)
ins.insert(2, 7)
ins.insert(99, 5)
ins.insert(-1, 6)
ins.insert(-99, 4)
print(ins, len(ins))
ins1 = [1]
ins1.insert(-1, 0)
print(ins1)
ins0: list[int] = []
ins0.insert(-3, 1)
print(ins0)

# **空容器装什么，答案在下一句里**（`xs = []` / `d = {}` 自己答不出）。
# 从前只认 `.append(v)` 与 `d[k] = v` 两种写法，于是下面这几种一样常见的开头
# 全撞在"空表 / 空字典的类型推不出来"上。收的都只是"当场答得出类型"的那一格实参。
f_xs = []
f_xs.extend([1, 2])
f_xs.append(3)
print(f_xs, len(f_xs))
f_ys = []
f_ys.insert(0, "b")
f_ys.insert(0, "a")
print(f_ys)
f_zs = []
f_zs += [1.5, 2.5]
print(f_zs, sum(f_zs))
f_d = {}
f_d.setdefault("a", 0)
f_d["a"] += 1
f_d.setdefault("a", 9)
f_d.setdefault("b", 7)
print(sorted(f_d.items()), len(f_d))
f_e = {}
f_e.update({"x": 1})
f_e["y"] = 2
print(sorted(f_e.items()))
