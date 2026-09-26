"""class —— 落成方言的 `(class …)`（引用语义）+ `<类名>_<方法>`。

`self` 是第一格实参；字段从**类级标注**与 `__init__` 顶层那几句 `self.x = …` 认。
方法按接收者类型挑实例，走的是单态化那张表（与自由函数同一条路）。

**明说的不足**：类**不按实参单态化** —— 一格 `(class …)` 只有一份字段表。所以
`Point(3, 4)` 与 `Point(1.5, 2.5)` 混着造不行（字段要退到 dyn，而方言的字段还不收 dyn）。
想要浮点的那一档，给字段一格标注 —— 下面的 `Vec2` 就是。
"""


class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def norm2(self):
        return self.x * self.x + self.y * self.y

    def shift(self, d):
        self.x = self.x + d
        self.y = self.y + d

    def show(self):
        print("(", self.x, ",", self.y, ") 平方长度", self.norm2())


p = Point(3, 4)
p.show()
print(p.x)
print(p.y)
print(p.norm2())

p.shift(1)
p.show()

p.x = 10
print(p.x)
print(p.norm2())

# 引用语义：两个名字指同一格
q = p
q.x = 99
print(p.x)


class Vec2:
    x: float
    y: float

    def __init__(self, x, y):
        self.x = x
        self.y = y

    def len2(self):
        return self.x * self.x + self.y * self.y


v = Vec2(1.5, 2.5)
print(v.x, v.y, v.len2())
