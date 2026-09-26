"""一格变量换类型、一个函数交不同的东西 —— 也退到 dyn。

`x = 1` 之后 `x = "hello"` 在 python 里天经地义；`def f(v)` 一支 return 数、一支 return 串
也一样。方言里一格变量只装一种东西 —— 那一种**可以是 dyn**。三条腿与 python3 逐字节相同。

箱子上的算术按 `(dtag …)` 两边各问一次：int 与 int 还是 int、混着来出 real、串与串拼起来。
`1 == "1"` 是 False（标签不同型），不是报错 —— python 的规矩。
"""

x = 1
print(x)
x = "hello"
print(x)
x = 2.5
print(x)
x = True
print(x)

y = 1
print(y)
y = 2.5
print(y + 1)
print(y * 2)
print(y - 0.5)
print(y / 2)

z = 3
print(z + 4)
print(z * 2)
z = "ab"
print(z + "cd")

print(z == "ab")
print(z == 1)
print(z != 1)

w = 1
print(w == 1.0)
print(w == True)
print(w == 2)
w = 1.0
print(w == 1)

# `//` `%` `**` 也走这条道：两边都是整数走整数那一支，否则按 real 算
m = 7
print(m // 2, m % 2, m ** 2)
m = 7.5
print(m // 2, m % 2)
m = -7
print(m // 2, m % 2)

# 位运算：两边都得是整数（python 里 `1.5 & 1` 是 TypeError）
k = 12
k = "x"
k = 12
print(k & 10, k | 3, k ^ 5, k << 2, k >> 2)

# `**` 的指数是负数时出浮点 —— 箱子上这一条在**运行期**问（静态那一侧靠字面量）
e = 3
e = "z"
e = -1
print(2 ** e)


def never_called(v):
    """一个调用点都没有、也没标注 —— 形参退到 dyn，不再报"给它一格标注"。"""
    return v


def show(v):
    """这一个被三种实参调过 —— 单态化成三格，**不**退到 dyn（推得出来优先）。"""
    print(v)


show(1)
show("a")
show(2.5)


def f(v):
    if v:
        return 1
    return "no"


print(f(1))
print(f(0))


def g(n):
    if n > 0:
        return 1
    return 2.5


print(g(1))
print(g(-1))


# 箱子上的 `*`：**一边是串、一边是整数就重复**（python 里 `"ab" * 3`）。
# 不接这一支的症状不是"还没接"，而是运行期一句 `dynamic value is string, expected real`
# —— `(asnum …)` 把串往数上掰。量到的路子就是下面这几行（v 先装数、后装串 ⇒ 合成 dyn）。
v = 1
print(v * 2)
v = "ab"
print(v * 3, 3 * v, v * 0 + "|", v * -1 + "|")


def twice(k):
    return k * 2


print(twice(3), twice("xy"), twice(1.5))


# **类的字段也退到箱子**：函数按实参类型单态化，可**类不**（一格 `(class Point …)` 只有
# 一份字段表），所以 `Point(3, 4)` 与 `Point(1.5, 2.5)` 里 `x` 装的东西不同型时，那一格
# 字段就是 dyn。要静态的那一档给字段一格标注（`x: float`）。
# 方言那一侧的字段白名单从前没有 dyn，所以这一片整个走不通 —— 开了口之后
# `structLayout` / 零值 / 三条腿的字段读写全是现成的。
class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def __str__(self) -> str:
        return "(" + str(self.x) + "," + str(self.y) + ")"

    def total(self):
        return self.x + self.y


a = Point(3, 4)
b = Point(1.5, 2.5)
print(a, b)
print(a.x, b.y, a.total(), b.total())
print(a.x == 3, b.x > 1, str(a.y))
# 装回去：字段那一格是箱子，装什么都行（python 自己就这样）
a.x = 10
print(a, a.total())
a.x = "ten"
print(a, f"{a.x}/{a.y}")
ps = [Point(1, 2), Point(0.5, 0.5)]
for p in ps:
    print(p, p.total())

