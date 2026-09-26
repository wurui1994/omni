# ext/python/examples/generic.py —— **单态化**：同一个函数按实参类型生成几格
#
# python 的鸭子类型撞上方言的静态类型：`add(2, 3)` 与 `add(1.5, 2.5)` 在 python 里是同一个
# `add`，在方言里是两个函数（`add__int_int` / `add__float_float`）。
# 这一份的每一行都在量那一格挑得对不对 —— 挑错了 diff 立刻现形。


def add(a, b):
    return a + b


def twice(x):
    return add(x, x)


def bigger(a, b):
    if a > b:
        return a
    return b


def head(xs):
    return xs[0]


def count(xs):
    n = 0
    for _ in xs:
        n += 1
    return n


def describe(x):
    return "<" + str(x) + ">"


def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


# **空容器的类型从"它被递给哪一格形参"认**（`bindFromParams`）。
# `memo = {}` 那一句自己答不出键值类型（与 `d[k] = v` 同一条口径：赋值先不绑，等走到用它的
# 那一句）；而 `fibm(20, memo)` 里那格形参标注了 `dict[int, int]` —— 那就是它的类型。
# 一样的信息，只是从前不从那一侧看：那时报"空字典 `{}` 的键值类型推不出来"。
#
# **明说的不足**：`memo` 那一格形参**也不标注**时还是不行 —— 调用点收不到实例、形参退到
# 箱子，报的是"`in` 作用在 dyn 上还没接 —— 形参没标注、调用点又推不出来时会退到箱子"。
# 要从函数体里那句 `memo[n] = v` 反推形参，那是另一刀（三轮推断里还有一处循环要解）。
def fibm(n: int, memo: dict[int, int]) -> int:
    if n in memo:
        return memo[n]
    if n < 2:
        return n
    v = fibm(n - 1, memo) + fibm(n - 2, memo)
    memo[n] = v
    return v


def total(xs: list[int]) -> int:
    s = 0
    for v in xs:
        s += v
    return s


def main():
    # 三格实例：int / float / str
    print(add(2, 3), add(1.5, 2.5), add("a", "b"))
    print(twice(4), twice(0.5), twice("ab"))
    print(bigger(3, 7), bigger(1.5, -2.5), bigger("a", "b"))

    # 容器那一族也各一格
    print(head([1, 2, 3]), head([1.5, 2.5]), head(["x", "y"]))
    print(count([1, 2, 3]), count([1.5]), count("abcd"))

    # 转串那一族：布尔、整数、浮点、串、表各走 repr 的口径
    print(describe(7), describe(2.5), describe("s"), describe(True))
    print(describe([1, 2]), describe([1.5]))

    # 递归的那一格（返回类型要从 `return n` 那一支推出来，没有标注）
    print(fib(10), fib(1), fib(0))

    # 空容器的类型从形参认（上面那段账）
    memo = {}
    print(fibm(20, memo), len(memo), memo[10])
    acc = []
    acc.append(3)
    print(total(acc))
    empty = []
    print(total(empty), len(empty))


main()
