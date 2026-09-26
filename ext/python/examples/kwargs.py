# ext/python/examples/kwargs.py —— 命名实参、默认值、多目标赋值
#
# **命名实参与默认值走同一处**（`kwOrder`）：命名的按形参名字排回位置上，缺的那几格
# 把 `def` 上那棵**默认值的原文树**补上去。三处都要排：建 IR 那一趟、问类型那一趟
# （`tyOfCall`）、**收单态化实例那一趟**（`collectInsts`）—— 漏掉最后一处的症状是
# 按次序取的类型错位，挑出来的实例是错的那一格。
#
# 默认值是**调用点展开**的，所以它只收**字面量**，外加**模块级那几格常量**
# （`RATE = 0.08` 上头、`def f(x=RATE)` 下头 —— 补的是它那棵字面量）。
# 为什么这两档够而别的不够：python 的默认值是 `def` 那一刻算一遍、以后**共享同一格**，
# `def f(xs=[])` 两次调用改的是同一张表 —— 展开就成了两张。字面量看不出区别；
# 模块级常量也看不出（往后再改那个名字也换不动已经算好的那一格，展开成字面量正是这条）。
# 可变的差得是根本的，所以那一档当场报，不悄悄换语义。
# 常量那一条要"只赋过一次"：赋两回就说不清 `def` 排在哪一回后头，那时照旧报。
#
# 内建各有各的规矩，所以不走那条通路：`print(sep=, end=)` 与 `sorted(reverse=, key=)`
# 在各自那一处收。`sorted(reverse=…)` **只收 True / False 字面量** —— 升序降序
# 是两条循环，得在编译期定（与 `range(a, b, step)` 的步长同一条理由）。
# `sorted(key=…)` 收的是**lambda 字面量**（就地展开，见 `listops.py`）。
#
# 多目标赋值（`a, b = x, y`，含 `a, b = b, a` 那个交换）也在这一份里：
# 发射那一侧本来就对（右边全算完再赋），缺的是**绑定那一趟**没逐格对着绑。


RATE = 0.08
MARK = "*"
BACK = -1


def area(w: int, h: int) -> int:
    return w * h


def greet(name: str, greeting: str) -> str:
    return greeting + ", " + name


def tag(text, mark="!", times=1):
    return text + mark * times


def step(x: int, by: int = 1) -> int:
    return x + by


def dbl(k):
    return k * 2


def grow(x, rate=RATE):
    return round(x * (1 + rate), 4)


def deco(s, mark=MARK, times=2):
    return s + mark * times


def back(x, by=BACK):
    return x + by


class Box:
    def __init__(self, w, h=2):
        self.w = w
        self.h = h

    def area(self, k=1):
        return self.w * self.h * k

    def scaled(self, rate=RATE):
        return round(self.w * self.h * (1 + rate), 4)


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

    # 默认值：不给、给一格、给全、用名字挑着给
    print(tag("a"), tag("a", "?"), tag("a", "?", 3), tag("a", times=2))
    print(step(1), step(1, 5), step(by=9, x=2))

    # 类的 __init__ 与方法上的默认值
    bx = Box(3)
    by = Box(3, 4)
    print(bx.w, bx.h, by.w, by.h)
    print(bx.area(), bx.area(2), by.area(k=2))

    # 默认值写的是模块级那格常量
    print(grow(100.0), grow(100.0, 0.5), grow(100.0, rate=0.0))
    print(deco("a"), deco("a", "?"), deco("a", MARK, 3), deco("a", times=1))
    print(back(5), back(5, 2), back(5, by=10))
    print(bx.scaled(), bx.scaled(0.0), by.scaled(rate=1.0))

    # **实参是局部变量**也要收得到实例（从前这一格漏了：平铺全树扫的时候
    # 局部变量在 tyOfCst 那儿答 null，于是 `dbl(v)` 报"没有对得上的那一格"）
    v = 21
    print(dbl(v), dbl(2), dbl(v * 2))
    s = "ab"
    print(dbl(s))

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

    # print(*xs) —— 要印的那几段先攒成一张串表，再用分隔符 join。
    # **空表那一格不多摆一个分隔符**（`print("a", *[], "b")` 是 `a b`）——
    # 表的长度是运行时才知道的，所以"有几段"只能在运行时数。
    args = [1, 2]
    print(*args)
    print("a", *args, "b")
    print(*args, sep="-")
    names = ["p", "q"]
    print(*names, sep="")
    print("x", *names, "y", sep="|")
    none2: list[int] = []
    print("a", *none2, "b")
    print(*none2)
    print(*"ab")
    print(*args, end="!\n")

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

    # **右边是一张表**（`s.split(",")` 那种最常见）—— 长度要跑起来才知道，
    # 所以发一句运行期的检查（python 那儿是 ValueError），再按下标逐格取
    left, right = "a,b".split(",")
    print(left, right)
    one, two, three = [1, 2, 3]
    print(one, two, three)
    head, tail = "k=v".split("=", 1)
    print(head, tail)


main()
