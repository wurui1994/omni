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
