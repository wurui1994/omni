# ext/python/examples/dictdel.py —— 字典删一格：`del d[k]` / `.pop()` / `.clear()`
#
# 方言这一刀加的是 `(ddel d k)`（答"原先在不在"）。运行时那一半早就有（`_remove`
# 连墓碑都维护了），缺的只是方言的开口 —— 与 `dkeys` 那一刀同一条来路。
#
# 这一份要钉的是**删过之后次序还对**：删只灭 `live[i]`、不挪 `keys[]`，新的一格追在
# 尾巴上。python 的 dict 也是这么做的，所以两边的 `for k in d` 才对得上。
#
# `del d[k]` 键不在是 KeyError、`.pop(k)` 也是 —— 这一份**不判那两条**（python 那边
# 印的是一整段 traceback，我们印的是一行），只判走得通的那几条。
# 表上的 `del xs[i]` 顺带接上（没有新算子：往前挪一格再 `apop`，与 `.pop(i)` 同一条）。


def main():
    ages = {"ann": 31, "bob": 24, "cid": 45}

    # del d[k]
    del ages["bob"]
    print(len(ages), "bob" in ages, "ann" in ages)
    print(ages)

    # 删过再加：新的一格追在尾巴上
    ages["dee"] = 12
    print(ages)
    for who in ages:
        print(who, ages[who])

    # .pop(k) —— 交走的那一格值
    got = ages.pop("ann")
    print(got, len(ages))
    print(ages)

    # .pop(k, 默认值) —— 键不在就交默认值，字典不动
    print(ages.pop("zzz", -1), len(ages))
    print(ages.pop("cid", -1), len(ages))
    print(ages)

    # 一句删几格
    box = {"a": 1, "b": 2, "c": 3, "d": 4}
    del box["a"], box["c"]
    print(box)

    # .clear()
    box.clear()
    print(box, len(box))
    box["fresh"] = 9
    print(box)

    # 删空再重来：次序从头算
    counts = {"x": 1, "y": 2}
    del counts["x"]
    del counts["y"]
    counts["z"] = 3
    counts["x"] = 4
    print(counts)
    print(list(counts.keys()))

    # 键是 int
    squares = {1: 1, 2: 4, 3: 9}
    del squares[2]
    print(squares, len(squares))
    print(squares.pop(3), squares)

    # 表上的 del（负下标也行）
    xs = [10, 20, 30, 40]
    del xs[1]
    print(xs)
    del xs[-1]
    print(xs)

    # 删到空表
    del xs[0]
    del xs[0]
    print(xs, len(xs))

    # `.popitem()` —— 拿掉**最后进来的**那一对（python 3.7 起是 LIFO），交两格的元组。
    # 删过再加之后"最后一格"是新加的那格，所以这几行也在钉次序。
    d2 = {"a": 1, "b": 2, "c": 3}
    print(d2.popitem(), d2)
    print(d2.popitem(), len(d2))
    d2["z"] = 9
    print(d2.popitem(), d2)
    e2 = {1: "x"}
    k, v = e2.popitem()
    print(k, v, len(e2))

    # **`del xs[a:b]` 就是 `xs[a:b] = []`**（python 那边这两句是同一件事），所以不另写一套
    xs = [1, 2, 3, 4, 5]
    del xs[1:3]
    print(xs)
    del xs[0:1]
    print(xs)
    del xs[5:9]
    print(xs)
    del xs[-1:]
    print(xs, len(xs))


main()
