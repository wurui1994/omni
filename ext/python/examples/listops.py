# ext/python/examples/listops.py —— 表上的拼接与重复，加上剩下那几个内建
#
# 这一刀补的全是"方言里没有、可用已有算子拼得出来"的格子，一个新算子都没加：
#   `xs + ys` / `xs * n`（新造一张表，两趟循环）、`reversed(xs)`、`repr(x)`、
#   `hex/oct/bin`、`round(x, n)`、`sum(xs, start)`、带步长的切片。
#
# **`round()` 是这里唯一一处"从前会答错"的地方**：python 的 round 是半数取偶
# （`round(2.5)` 是 2），而方言的 `(rmath "round")` 是 C 的"远离零"（交 3）。
# 现在用 floor / fmod 拼出半数取偶（`builtins.js` 的 `bankRound`）。
#
# 明说的不足（都在下面注掉的那几行里写着）：
#   - 两参 `round` 我们走二进制的乘除，CPython 走十进制（`_Py_dg_dtoa`）——
#     `round(2.675, 2)` python 交 2.67、我们交 2.68。根子是 `2.675 * 100.0`
#     在双精度里真是 267.5，不是 `bankRound` 错。
#   - 负步长的切片只接两头都省掉的写法（`s[::-1]`）。


def main():
    xs = [1, 2, 3]
    ys = [4, 5]

    # 拼接：新造一张表，两边都不动
    print(xs + ys, xs, ys)
    # 与空表拼：**空表字面量要先有一格标注**（`[]` 自己的元素类型推不出来 ——
    # 这一条是既有的那一格口径，不是拼接这一刀新欠的）
    none: list[int] = []
    print(xs + none, none + xs)

    # 重复：n <= 0 给空表
    print(xs * 2, 2 * xs, xs * 0, xs * -1)
    print([0] * 5, ["ab"] * 2)

    # 表里套表也拼得起来
    print([[1], [2]] + [[3]])

    # reversed()：交倒过来的一张新表（原表不动）
    print(list(reversed(xs)), xs)
    print(list(reversed(["a", "b", "c"])))

    # repr()：与 str() 只差串上那对引号
    print(repr("x"), repr(1), repr(2.5), repr(True), repr([1, "a"]))
    print(str("x"), str([1, "a"]))

    # hex / oct / bin：方言的 (sbase E 进制) 加上前缀；负数走 `-` 加取反那一格
    print(hex(255), oct(8), bin(5))
    print(hex(0), oct(0), bin(0))
    print(hex(-255), oct(-8), bin(-5))

    # round：半数取偶
    print(round(0.5), round(1.5), round(2.5), round(3.5))
    print(round(-0.5), round(-1.5), round(-2.5))
    print(round(0.4), round(0.6), round(-0.4), round(-0.6))
    print(round(1.0 / 3.0, 3), round(2.0, 1), round(2.345, 2))

    # sum 带起点
    print(sum([1, 2], 10), sum([1.5, 2.5], 1), sum(xs, 0))

    # 带步长的切片
    print("abcdef"[::2], "abcdef"[1::2], "abcdef"[::3])
    print("abcdef"[::-1], "abcdef"[::-2])
    print(xs[::-1], [1, 2, 3, 4, 5][::2], [1, 2, 3, 4, 5][1:4:2])
    print(""[::-1], [0][::-1])

    # 拼起来接着用
    total = 0
    for v in xs + ys:
        total += v
    print(total, len(xs * 3))


main()
