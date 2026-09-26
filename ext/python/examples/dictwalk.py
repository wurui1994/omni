# ext/python/examples/dictwalk.py —— 走一遍字典的键
#
# 方言原先没有"走一遍字典"那一格：`for k in d` / `d.keys()` / `d.values()` /
# `d.items()` / `print(d)` 全卡在同一处。这一刀往方言加了 `(dkeys d)`（交一格
# `(arr K)`，插入序），上面那五种写法都落在它上头。
#
# 次序是判据的一半：python 3.7+ 的 dict 是**插入序**，运行时里 `_keys` 也是按
# `d->keys[]` 追加的次序、删除只灭 live —— 所以两边对得上。这一份里 c/a/b 与
# 30/10/20 那两串就是判这一条的。
#
# **明说的不足**（两条）：
#   1. `d.keys()` 在 python 里交的是一格**视图**（`dict_keys([...])`，改字典之后
#      它跟着变），我们交的是抄出来的一张表。所以这一份一律写 `list(d.keys())` ——
#      那种写法两边逐字相同。裸 `print(d.keys())` 不判（python 印
#      `dict_keys(['a'])`，我们印 `['a']`）。
#   2. 同一个作用域里**同一个名字**当两张键类型不同的字典的循环变量，那个名字会
#      合成 dyn（ADR-0008），而方言的 `dget` 的键要静态对上 —— 于是 `d[k]` 报
#      「dget 的键要是 string，这里是 dynamic」。下面因此每一处各起一个名字
#      （`who` / `idx` / `item`）。python 自己不在意，这是我们这一侧的账。


def letters(text: str) -> dict[str, int]:
    seen: dict[str, int] = {}
    for ch in text:
        if ch in seen:
            seen[ch] = seen[ch] + 1
        else:
            seen[ch] = 1
    return seen


def letters2(text: str) -> dict[str, int]:
    """同一件事**不带标注** —— `{}` 的键值类型从后面那句 `seen[ch] = 1` 认。

    要紧的是那一句在 **else 支**里：`scanBinds` 那一趟从前不剥 `(else (body …))`
    这一层，于是 else 支里的赋值一格都不绑，这儿会报"空字典的键值类型推不出来"。
    """
    seen = {}
    for ch in text:
        if ch in seen:
            seen[ch] = seen[ch] + 1
        else:
            seen[ch] = 1
    return seen


def sum_values(d: dict[str, int]) -> int:
    s = 0
    for k in d:
        s += d[k]
    return s


def group_by_len(words: list[str]) -> dict[int, list[str]]:
    """字典装一串表。

    卡的从来不是 adapter 这一侧（从 `by_len[n].append(w)` 就认得出
    `map<int, arr<string>>`），是方言那一侧的口：`(dict K V)` 的值原先**按原子读**，
    `(arr string)` 是一张表、不是一个词，写都写不出来。
    """
    by_len: dict[int, list[str]] = {}
    for w in words:
        n = len(w)
        if n not in by_len:
            by_len[n] = []
        by_len[n].append(w)
    return by_len


def total_len(g: dict[str, list[int]]) -> int:
    s = 0
    for k in g:
        s += len(g[k])
    return s


def main():
    ages = {"ann": 31, "bob": 24, "cid": 45}

    # for k in d —— 走的是键
    for who in ages:
        print(who, ages[who])

    # .keys() / .values()
    print(list(ages.keys()))
    print(list(ages.values()))
    print(len(ages.keys()), len(ages.values()))

    # .items() —— 两格目标
    for name, age in ages.items():
        print(name + "=" + str(age))

    # print(d) / str(d)：键与值都走 repr（所以串带引号）
    print(ages)
    print(str(ages))

    # 空字典
    empty: dict[str, int] = {}
    print(empty)
    print(len(empty.keys()))
    for gone in empty:
        print("never" + gone)

    # 插入序，不是排序后的次序
    order: dict[str, int] = {}
    order["c"] = 30
    order["a"] = 10
    order["b"] = 20
    print(order)
    for step in order:
        print(step)
    print(list(order.values()))

    # 抄出来的那一张表：往里 append 不动字典
    ks = list(ages.keys())
    ks.append("zzz")
    print(len(ks), len(ages))

    # 值表走一遍
    print(sum(ages.values()), sum_values(ages))

    # 键是 int 的字典
    squares: dict[int, int] = {}
    for i in range(4):
        squares[i] = i * i
    print(squares)
    for idx in squares:
        print(idx, squares[idx])
    print(sorted(squares.keys()))

    # 值是 real
    price = {"tea": 2.5, "cake": 4.0}
    print(price)
    for item, cost in price.items():
        print(item, cost)

    # 数一遍字母（键的次序 = 第一次出现的次序）
    counts = letters("abracadabra")
    print(counts)
    print(list(counts.keys()))
    # `sorted(字典)` 排的是**键**（与 `for k in d` 一条）
    print(sorted(counts), sorted(counts.keys()))
    print(letters2("abracadabra"), letters2("") == counts)

    # 空字典**不带标注**：键值类型从后面那句 `m[k] = v` 认
    m = {}
    m["k"] = 1
    m["j"] = 2
    print(m, len(m), m["k"])
    nums = {}
    nums[1] = "one"
    print(nums, nums[1])
    reals = {}
    reals["pi"] = 3.5
    print(reals)

    # 值是一张表：分组那种写法
    groups = group_by_len(["apple", "fig", "kiwi", "plum", "a"])
    print(groups)
    for size in groups:
        print(size, groups[size], len(groups[size]))
    print(sorted(groups))
    print(groups[3][0], groups[4][1])

    # `for k in sorted(d)` —— 排完的键当循环目标（`sorted(d)` 的**类型**从前没给，
    # 于是那个循环变量绑不上；`print(sorted(d))` 那条路上没人问过类型，所以看不出来）
    for key in sorted(groups):
        print(key, groups[key])
    # `list(d)` 也是键（与 `list(d.keys())` 一条）
    names = list(ages)
    print(names, len(names))
    for nm in list(ages):
        print(nm)

    # 引用语义：`d[k]` 读回来的是那张表本身，不是抄一份
    inner = groups[3]
    inner.append("zzz")
    print(groups[3], len(groups[3]))

    # 不带标注的那一档：`{}` 的值类型从 `d[k].append(v)` 认
    bag = {}
    bag["odd"] = []
    bag["even"] = []
    for i in range(6):
        if i % 2 == 0:
            bag["even"].append(i)
        else:
            bag["odd"].append(i)
    print(bag, total_len(bag))
    bag["even"].sort()
    print(bag["even"], sum(bag["even"]), max(bag["odd"]))

    # `d[k] = d.get(k, 0) + 1` —— 数一遍那种写法。**这一句绕回来了**：右边要先知道 `tally`
    # 装什么（`.get` 问的是它），而 `tally` 装什么正要从右边认。可 `1` 就摆在那儿 ——
    # 方言的 `+` 要两边同型，于是**答得出来的那一边就是答案**（`looseTy`）。
    # `tally[w] = tally[w] + 1` 是同一条。
    tally = {}
    for w in "b a c b a b".split():
        tally[w] = tally.get(w, 0) + 1
    print(tally, len(tally), tally["b"])
    print(sorted(tally.items()))
    again = {}
    for w in "x y x".split():
        if w in again:
            again[w] = again[w] + 1
        else:
            again[w] = 1
    print(again)

    # 两层配置（字典的值也是一张字典）——`cfg[sec][key] = v`。方言那一侧与"值是一张表"
    # 同一档：格子里躺一个句柄。**一个标注都不写也认得出来**：`cfg = {}` 与
    # `cfg["db"] = {}` 两句自己都答不出，答案在**再下一句** `cfg["db"]["port"] = 5432`
    # 里 —— 绑那一趟把"值是 (dict str int)"往外推一层再问一遍。
    cfg = {}
    cfg["db"] = {}
    cfg["db"]["port"] = 5432
    cfg["db"]["pool"] = 8
    cfg["web"] = {}
    cfg["web"]["port"] = 80
    print(len(cfg), sorted(cfg), cfg)
    print(cfg["db"]["port"], len(cfg["db"]), sorted(cfg["db"]))
    for sec in sorted(cfg):
        for ck in sorted(cfg[sec]):
            print(sec, ck, cfg[sec][ck])
    ctot = 0
    for sec in cfg:
        for ck in cfg[sec]:
            ctot += cfg[sec][ck]
    print(ctot, "db" in cfg, "nope" in cfg, "port" in cfg["db"])
    # 带标注的那一档（写清楚也一样走）
    cfg2: dict[str, dict[str, str]] = {}
    cfg2["a"] = {}
    cfg2["a"]["k"] = "v"
    print(cfg2, len(cfg2["a"]))


main()
