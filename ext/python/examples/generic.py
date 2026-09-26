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


main()
