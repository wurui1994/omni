# ext/python/examples/moreops.py —— 改原容器的那几格、`for…else`、`isinstance`
#
# 这一批还是"方言里没有、可用已有算子拼得出来"：
#   `xs.sort()` / `xs.sort(reverse=True)`（**就地**排，`sorted()` 才抄一份）、
#   `d.update(other)`、`d.setdefault(k, v)`、`for…else` / `while…else`、`isinstance`。
#
# `for…else` 那一支是"**没 break 就跑**"，不是"循环完就跑"。落法是一格布尔旗子：
# 进循环前置 True，体里**属于这一层**的每个 `break` 前面补一句置 False，出来之后
# `if 旗子:`。"属于这一层"要紧 —— 嵌套循环里的 break 跳的是里层那一圈，与这一格无关。
#
# `isinstance` 静态的那一档在**编译期**就答得出（这一层的类型是确定的）；一格箱子
# 那一档问 `(dtag …)`。`isinstance(True, int)` 照 python 交 True（bool 是 int 的子类）。


class Tag:
    def __init__(self, n: int):
        self.n = n


def main():
    # 就地排
    xs = [3, 1, 2]
    xs.sort()
    print(xs)
    xs.sort(reverse=True)
    print(xs)
    ws = ["pear", "fig", "apple"]
    ws.sort()
    print(ws)
    rs = [2.5, 1.5, 3.5]
    rs.sort()
    print(rs)
    # sorted() 不动原表，sort() 动
    ys = [3, 1, 2]
    print(sorted(ys), ys)
    ys.sort()
    print(ys)

    # d.update / d.setdefault
    d = {"a": 1}
    d.update({"b": 2, "a": 9})
    print(d)
    print(d.setdefault("c", 3), d)
    print(d.setdefault("a", 100), d)
    e: dict[str, int] = {}
    e.update(d)
    print(len(e), e["a"])

    # for … else
    for i in [1, 2, 3]:
        if i == 9:
            break
    else:
        print("for: no break")
    for i in [1, 2, 3]:
        if i == 2:
            break
    else:
        print("for: never printed")
    print("after")

    # 嵌套：里层的 break 不影响外层那一支
    for i in [1, 2]:
        for j in [3, 4]:
            if j == 3:
                break
    else:
        print("outer: no break")

    # while … else
    n = 0
    while n < 2:
        n += 1
    else:
        print("while: no break", n)
    m = 0
    while m < 5:
        m += 1
        if m == 2:
            break
    else:
        print("while: never printed")
    print("m =", m)

    # isinstance：静态那一档
    v = 1
    r = 2.5
    s = "hi"
    b = True
    print(isinstance(v, int), isinstance(r, float), isinstance(s, str), isinstance(b, bool))
    print(isinstance(v, float), isinstance(s, int), isinstance(b, int))
    print(isinstance(xs, list), isinstance(d, dict), isinstance(xs, dict))
    print(isinstance(Tag(1), Tag))

    # isinstance：箱子那一档（同一个名字装过几种东西就退到 dyn）
    box = 1
    print(isinstance(box, int), isinstance(box, str))
    box = "now a string"
    print(isinstance(box, int), isinstance(box, str))
    box = 2.5
    print(isinstance(box, float), isinstance(box, int))


main()
