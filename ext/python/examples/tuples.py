# ext/python/examples/tuples.py —— 元组
#
# 元组**按形状生成一格记录**：`(1, "a")` 的类型是 `Tup2_int_string`，字段 `_0` / `_1`。
# 为什么不给标准 IR 加一档"元组"：元组就是**定长、逐格各有自己类型**的东西，那正是记录 ——
# 而记录这一档从声明、字段读写到四条腿早就通了。引用语义（`cnew`）：python 的元组
# 不可改，"是不是同一份存储"观察不到。
#
# 字段名是 `_0` / `_1`，而方言的字段是**名字**不是下标 —— 所以 `t[0]` 里那个下标
# **要写成字面量**（python 代码里几乎总是；负的也行，编译期折过去）。
#
# 落地时量出来的两条：
#   1. `inferFields` 会把元组那几格记录的字段**抹成空**（它是从标注与 `__init__` 认字段的，
#      而元组两样都没有）—— 先报"类 Tup2_int_string 至少要有一个字段"，接着字段读回来的
#      类型也跟着错。所以那一趟要跳过元组。
#   2. 元组的声明是**建 IR 的时候**才登记的，所以 `pyToIR` 里"先摆声明再建体"的次序
#      得反过来 —— 不然声明表看不见它们。
#
# 明说的不足：空元组 `()` 不收（记录至少要一格字段 —— 所以切出来是空的那几刀也不收）；
# 形状不同的两格元组比大小不收（python 是"逐格比到第一处不同、都一样就短的那格小"，
# 而对上的两格类型不同那一处还会 TypeError）；链式比较里中间那一格要是元组字面量不收
# （那一格只算一遍，所以要求它是纯的）；
# 下标与切片的边界不是字面量不收（逐格类型不同，形状得在编译期知道）；
# 推导式 / for 里嵌套的拆包（`for a, (b, c) in …`）不收。


def pair() -> tuple[int, str]:
    return 7, "seven"


def divmod2(a: int, b: int) -> tuple[int, int]:
    return a // b, a % b


def main():
    # 字面量、下标、一格的那种
    t = (1, "a")
    print(t, t[0], t[1], t[-1], t[-2])
    u = (2.5,)
    print(u, u[0], len(u))
    print((1, 2.5, "s", True))

    # 交出去、拆回来
    print(pair())
    x, y = pair()
    print(x, y)
    q, r = divmod2(17, 5)
    print(q, r)
    a, b = t
    print(a, b)

    # 逐格比（比的是内容，不是"同一个句柄"）
    print((1, 2) == (1, 2), (1, 2) == (1, 3), (1, 2) != (1, 2))
    print(("x", 1) == ("x", 1), ("x", 1) == ("y", 1))
    print(t == (1, "a"))

    # 长度在编译期就定了；非空的元组恒真
    print(len(t), len((1, 2, 3)))
    if t:
        print("truthy")

    # 字典序：第一处不同的那一格说了算（落成一棵短路的纯表达式，不发分支）
    print((1, 2) < (1, 3), (1, 2) < (1, 2), (1, 2) <= (1, 2))
    print((1, 2) > (2, 0), (1, 2) >= (1, 2), (2, 0) >= (1, 9))
    print(("a", 1) < ("b", 0), ("a", 2) < ("a", 10))
    print((1, 2, 3) < (1, 2, 4), (1, 2, 3) < (1, 2, 3))
    print((1.5, "x") < (1.5, "y"))

    # 有了"怎么比"，挑大小与排序就都走得通了
    ps = [(2, "b"), (1, "a"), (1, "A")]
    print(min(ps), max(ps))
    print(min((2, "b"), (1, "a")), max((2, "b"), (1, "a")))
    print(sorted(ps))
    print(sorted(ps, reverse=True))
    qs = [(2, 1), (1, 9), (1, 2)]
    qs.sort()
    print(qs)
    qs.sort(reverse=True)
    print(qs)

    # 一串元组
    ts = [(1, "a"), (2, "b")]
    print(ts, ts[1][1])
    for i, s in ts:
        print(i, s)

    # zip / enumerate / d.items() 当值用 —— 交一张元组的表
    d = {"x": 1, "y": 2}
    print(list(d.items()))
    print(list(zip([1, 2], ["a", "b"])))
    print(list(zip([1, 2, 3], ["a", "b"])))
    print(list(enumerate(["p", "q"])), list(enumerate(["p", "q"], 1)))
    print(list(zip("ab", [1, 2])))
    for k, v in d.items():
        print(k, "=", v)

    # **N 张表一起 zip** —— 交一串 N 格的元组，走到最短的那一张为止
    print(list(zip([1, 2], [3, 4], [5, 6])))
    print(list(zip([1, 2, 3], "ab", [7, 8, 9, 10])))
    print(list(zip([1], [2], [3], [4])))
    for a3, b3, c3 in zip([1, 2], [3, 4], [5, 6]):
        print(a3, b3, c3)
    # 一串 N 格元组直接拆开走（不必是 zip 交出来的）
    tri = [(1, "a", 2.5), (2, "b", 3.5)]
    for i3, s3, f3 in tri:
        print(i3, s3, f3)
    print([p + q + r for p, q, r in zip([1, 2], [10, 20], [100, 200])])

    # 推导式里也走得通
    print([(i, v) for i, v in enumerate([10, 20])])
    print([p[0] for p in ts])
    print([m + n for m, n in zip([1, 2], [10, 20])])
    print({v: k for k, v in d.items()})

    # 切元组：形状是**编译期**算出来的（三个边界都要写成字面量）
    t3 = (1, 2, 3)
    t4 = (1, 2, 3, 4)
    print(t3[1:], t3[:2], t3[:], t3[0:2])
    print(t3[-2:], t3[:-1], t3[-3:-1])
    print(t4[::2], t4[1::2], t4[::-1])
    print((1, "a", 2.5)[1:], (1, "a", 2.5)[:2])
    print(t3[0:99], t3[-99:], len(t3[0:2]), t3[1:][0])

    # 元组当序列用：`in` 编译期展开成一串 `==`，走一遍先摆进一张表
    print(1 in t3, 5 in t3, 1 not in t3)
    print("a" in (1, "a"), 9 in (1, "a"))
    for v in t3:
        print(v)
    for s in ("p", "q"):
        print(s)
    print(list(t3), list(("a", "b")), [v * 2 for v in t3])
    print(sum(list(t3)), max(list(t3)), sorted(list((3, 1, 2))))

    # 嵌套
    nested = (1, (2, 3))
    print(nested, nested[1][0])
    print(((1, 2), "z")[0][1])


main()

# ---- 排一串元组：**比较不许摆进 while 的条件里** ------------------------------
# 元组那一档的"怎么比"要把两边各钉一格临时量（逐格比要读好几遍），而**摆进 while 的条件里
# 那几格 let 会被提到 while 外头** —— 于是每转一圈读的还是头一圈那两个值，插入排序的内层
# 循环该停的时候不停。症状：**五格以上**的元组表 sorted() 出来是乱的（四格以下碰巧对，
# 所以先前没露）。现在比较摆在循环体里、用一格 "还往前挪吗" 的标记控制内层循环。
ps = [("the", 3), ("quick", 1), ("brown", 1), ("fox", 1), ("jumps", 1),
      ("over", 1), ("lazy", 1), ("dog", 1), ("end", 1)]
print(sorted(ps))
print(sorted(ps, reverse=True))
rs = [(3, "c"), (1, "a"), (2, "b"), (5, "e"), (4, "d")]
print(sorted(rs))
rs.sort()
print(rs)
rs.sort(reverse=True)
print(rs)
# 第一格相同时看第二格（字典序）
qs = [(1, "b"), (1, "a"), (0, "z"), (1, "c"), (0, "y"), (2, "a")]
print(sorted(qs))
print(min(qs), max(qs))
