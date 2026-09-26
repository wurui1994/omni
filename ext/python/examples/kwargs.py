# ext/python/examples/kwargs.py —— 命名实参与多目标赋值
#
# **命名实参只是换个次序**：这一层没有"默认值"那一档（`def` 的形参带默认值当场报），
# 所以 `f(b=2, a=1)` 按形参名字排回位置上就完事了。三处都要排：建 IR 那一趟、
# 问类型那一趟（`tyOfCall`）、**收单态化实例那一趟**（`collectInsts`）——
# 漏掉最后一处的症状是按次序取的类型错位，挑出来的实例是错的那一格。
#
# 内建各有各的规矩，所以不走那条通路：`print(sep=, end=)` 与 `sorted(reverse=)`
# 在各自那一处收。`sorted(reverse=…)` **只收 True / False 字面量** —— 升序降序
# 是两条循环，得在编译期定（与 `range(a, b, step)` 的步长同一条理由）。
# `sorted(key=…)` 没接：那要有"函数当值"那一档。
#
# 多目标赋值（`a, b = x, y`，含 `a, b = b, a` 那个交换）也在这一份里：
# 发射那一侧本来就对（右边全算完再赋），缺的是**绑定那一趟**没逐格对着绑。


def area(w: int, h: int) -> int:
    return w * h


def greet(name: str, greeting: str) -> str:
    return greeting + ", " + name


class Point:
    def __init__(self, x: int, y: int):
        self.x = x
        self.y = y

    def show(self) -> str:
        return "(" + str(self.x) + "," + str(self.y) + ")"


def main():
    # 命名实参：位置、全命名、混着、乱序，四种都是同一格
    print(area(2, 3), area(w=2, h=3), area(2, h=3), area(h=3, w=2))
    print(greet("ann", greeting="hi"), greet(greeting="yo", name="bob"))

    # 造一格记录也收（第一格 self 不算）
    p = Point(y=4, x=3)
    print(p.show())

    # 单态化按实参类型挑实例 —— 乱序之后也要挑对那一格
    print(area(2, 3), area(h=5, w=4))

    # sorted(reverse=)
    print(sorted([3, 1, 2]), sorted([3, 1, 2], reverse=True))
    print(sorted(["b", "a", "c"], reverse=True), sorted([2.5, 1.5], reverse=True))

    # print(sep=, end=)
    print("a", "b", "c", sep="-")
    print("x", end="")
    print("y", end="|")
    print()
    print(1, 2, 3, sep="", end="!\n")
    print("no args after this:", end=" ")
    print()

    # 多目标赋值
    a, b = 1, 2
    print(a, b)
    a, b = b, a
    print(a, b)
    x, y, z = 1, "s", 2.5
    print(x, y, z)
    p2 = q2 = 7
    print(p2, q2)
    xs = [1, 2, 3]
    xs[0], xs[2] = xs[2], xs[0]
    print(xs)
    # 右边先全算完：这一条靠的是那几格临时量
    i, j = 0, 1
    i, j = j, i + j
    print(i, j)


main()
