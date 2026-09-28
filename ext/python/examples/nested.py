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

    # **就地调用的 lambda**：把实参钉成一格临时量，再把形参名指到它上头就地展开
    # （`map` / `filter` / `key=` 用的是同一格 `applyPer`）。体里**调库方法**那一档
    # 还没接（`(lambda s: s.upper())("ab")` —— 现造的库实例少了局部变量的 `let`）。
    print((lambda v: v + 1)(5), (lambda v: v * 2)(3), (lambda v: v[0])([7, 8]))


# **一个调用点都没有的函数**（形参没标注 —— 那几格退到箱子）：从前它的返回类型一律
# 当 void，而体里 `return a + b` 交的是箱子，于是**漏到方言那一层**才报"要返回 void，
# 给的是 dynamic"。现在"体里有带值的 return"就退到箱子。这一格判据只要**编得出来**
# （python 那边没调用就不跑，印不出东西来）。
def never_called(a, b=10):
    return a + b


main()
