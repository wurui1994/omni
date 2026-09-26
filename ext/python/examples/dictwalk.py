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


main()
