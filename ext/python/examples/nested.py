# ext/python/examples/nested.py —— 函数里套函数（不读外层名字的那一档）
#
# python 的嵌套 `def` 有两种用法：一种只是"把一段逻辑关在里头"（不读外层的任何名字），
# 另一种是真闭包（读外层的局部）。**前者与模块级的 `def` 没有区别** —— 提到模块级就是，
# 单态化那一套照旧。后者要"把捕获的那几格连函数一起带走"，那是 `(asfn …)` 与环境那一层的
# 事，所以**当场报**，不悄悄把它当前者办（那会读到一个不存在的名字）。
#
# 判据就是一句话：**内层用到的名字里，有没有落在外层的形参或局部上**
# （内层自己的形参与局部先减掉 —— 那是遮住的，不算捕获）。
#
# 明说的不足：真闭包（`def grab(k): return k + n`，n 是外层形参）当场报；
# 套在里头的 `def` 与外头的重名当场报（提上去会撞）；`nonlocal` 还没接。


def squares(n: int) -> int:
    def helper(k: int) -> int:
        return k * k

    total = 0
    for i in range(n):
        total += helper(i)
    return total


def brackets():
    def wrap(s):
        return "[" + s + "]"

    return wrap("a") + wrap("b")


def three():
    def a1(k):
        return k + 1

    def a2(k):
        return a1(k) * 2

    return a2(3)


def main():
    print(squares(4), brackets(), three())

    # 内层的形参 / 局部把外层同名的那一格**遮住** —— 不算捕获
    def shadow(x):
        y = x + 1
        return y

    y = 100
    print(shadow(1), y)

    # 套进去的函数照样单态化（int 一格、串一格）
    def twice(v):
        return v * 2

    print(twice(3), twice("ab"))


main()
