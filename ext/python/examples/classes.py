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


# `__str__` —— `str(p)` 与 `print(p)` 都走它（python 就是这条规矩）。
# 没定义 `__str__` 的类当场报：python 那时印 `<__main__.X object at 0x…>`，里头有地址，
# 逐字节比不了，所以不装作有。
class Tagged:
    def __init__(self, name, n=0):
        self.name = name
        self.n = n

    def bump(self, by=1):
        # `self.n += by` 落成 `self.n = self.n + by`（接收者要是一格名字）
        self.n += by
        return self.n

    def __str__(self) -> str:
        return self.name + ":" + str(self.n)


tg = Tagged("hit")
print(str(tg))
print(tg)
print(tg.bump(), tg.bump(5), tg.n)
print(tg)
print(Tagged("x", 9))


# `self.xs: list[int] = []` —— **带标注的那一句是 `annot` 不是 `assign`**，
# 从前认字段那一趟只看 `assign`，于是这一格字段根本没认出来（报"没有字段 items（一格都没有）"）。
class Stack:
    def __init__(self):
        self.items: list[int] = []

    def push(self, v: int):
        self.items.append(v)

    def pop(self) -> int:
        return self.items.pop()

    def empty(self) -> bool:
        return len(self.items) == 0


st = Stack()
st.push(1)
st.push(2)
print(st.pop(), st.empty(), len(st.items), st.items)


# **字段上那张字典**（`self.tags: dict[str, int]`）—— 方言的字段白名单里从前没有 dict
# 那一格，于是整个类连声明都过不去，后面每一处 `self.tags` 跟着全红。与"字段是一张表"
# 同一档：格子里躺一个句柄，与标量同宽。字段的零值是**一张真的空字典**（不是空句柄），
# 所以 `self.bylen` 那一格不赋值就往里写也走得通。
class Counter:
    def __init__(self, xs: list[str], tags: dict[str, int]):
        self.xs = xs
        self.tags = tags
        self.bylen: dict[int, list[str]] = {}

    def add(self, w: str):
        self.xs.append(w)
        if w in self.tags:
            self.tags[w] = self.tags[w] + 1
        else:
            self.tags[w] = 1
        n = len(w)
        if n not in self.bylen:
            self.bylen[n] = []
        self.bylen[n].append(w)

    def extend(self, more: list[str]) -> int:
        for w in more:
            self.add(w)
        return len(self.xs)


# **实参位置上的 `[]` / `{}`**：右边答不出元素类型，**形参那一格**说了算 —— 与 `xs = []`
# 同一条（"空容器的类型从左边来"）。实参位置上压根没处写标注，所以从前 `Counter([], {})`
# 这种写法就此走不通（报"空表 `[]` 的元素类型推不出来 —— 给它一格标注"）。
c = Counter([], {})
print(len(c.xs), len(c.tags), len(c.bylen))
c.add("fig")
c.add("fig")
c.add("kiwi")
print(c.xs, c.tags, c.bylen)
print(c.tags["fig"], len(c.bylen[3]))
print(c.extend([]), c.extend(["plum", "a"]))
print(c.xs, sorted(c.tags), sorted(c.bylen))


# 字段上那张字典的**值是一格类**（`dict[str, Task]`）—— 方言那一侧 44-dicts 就收了
# （格子里躺一个句柄），这一刀之后从 python 这边够得着了。
class Task:
    def __init__(self, name: str, pri: int):
        self.name = name
        self.pri = pri

    def __str__(self) -> str:
        return "%s(p%d)" % (self.name, self.pri)


class Board:
    def __init__(self):
        self.tasks: dict[str, Task] = {}

    def add(self, t: Task):
        self.tasks[t.name] = t

    def order(self) -> list[str]:
        # `key=` 那个 lambda 读得着 `self`
        return sorted(sorted(self.tasks), key=lambda n: self.tasks[n].pri)


bd = Board()
bd.add(Task("build", 2))
bd.add(Task("test", 3))
bd.add(Task("lint", 1))
print(len(bd.tasks), bd.order())
for i, tn in enumerate(bd.order(), 1):
    print(i, bd.tasks[tn], bd.tasks[tn].pri)


# ---- 双下划线那几格：`__len__` / `__eq__` / `__lt__` ---------------------------
# 不接这几条的症状各不一样：`len(v)` 报"len 作用在 named 上没有这一格"；
# `v == w` 落成"**比句柄**"，`P(1) == P(1)` 静默答 False（python 按 `__eq__` 答 True）；
# `sorted(ps)` 报"要有怎么比"。现在三格都按 python 的规矩找方法。
# **`__eq__` 的 `other` 谁都不写标注** —— 这一层把它当"同一个类"（不然它退到 dyn，
# 而体里写的是 `other.k`，光是定义了 `__eq__` 就编不过）。
class P:
    def __init__(self, k: int):
        self.k = k

    def __str__(self):
        return "P" + str(self.k)

    def __len__(self) -> int:
        return self.k

    def __eq__(self, other) -> bool:
        return self.k == other.k

    def __lt__(self, other) -> bool:
        return self.k < other.k


ps = [P(3), P(1), P(2)]
print(P(1) == P(1), P(1) != P(2), P(1) < P(2), P(2) < P(1), len(P(4)))
# `in` / `.index()` / `.count()` 走的也是 `__eq__`（它们要的就是一格"怎么比相等"）
print(P(1) in ps, P(9) in ps, ps.index(P(2)), ps.count(P(1)))
print(min(ps), max(ps))
# **不印整张表**：python 那边元素走的是 `__repr__`（没定义就印 `<…object at 0x…>`，
# 那串里有地址、逐字节比不了），所以这儿逐格 `str()`
print([str(p) for p in sorted(ps)], [str(p) for p in sorted(ps, reverse=True)])
ps.sort()
print([str(p) for p in ps], len(ps))


# **另一批双下划线**：算术、`__repr__`、真值、下标、`in`、`-x`、调用。
# 两处从前是**静静答错**：定义了 `__repr__` 的类上 `repr(r)` 答的是 `__str__` 那一份；
# `bool(R(0))` / `if r:` 一律答 True（这一层从前把"一格对象"当恒真）。
# `__contains__` / `__getitem__` 的第二格形参没人标注，而 `3 in r` / `r[2]` 又不是方法
# 调用的形状 —— 收实例那趟看不见它，所以按用到的实参类型**现造一格**。
class R:
    def __init__(self, k: int):
        self.k = k

    def __str__(self):
        return "R(" + str(self.k) + ")"

    def __repr__(self):
        return "R!" + str(self.k)

    def __add__(self, o):
        return R(self.k + o.k)

    def __mul__(self, o):
        return R(self.k * o.k)

    def __neg__(self):
        return R(-self.k)

    def __bool__(self) -> bool:
        return self.k != 0

    def __contains__(self, v) -> bool:
        return v == self.k

    def __getitem__(self, i):
        return self.k + i

    def __call__(self, x):
        return self.k + x


r = R(3)
print(str(r), repr(r), r)
print([R(1), R(2)], f"{r} {r!r}", "%s %r" % (r, r), "{} {!r}".format(r, r))
print(str(r + R(4)), str(r * R(2)), str(-r))
print(bool(r), bool(R(0)), 3 in r, 4 in r, r[2], r(10))
if R(0):
    print("never")
if r:
    print("truthy")


# **继承** —— 编译期把父类的字段与方法**抄进子类**（方言的记录没有继承这一档，这一层
# 也不要 vtable）。抄方法为什么对：`C.fnNodes` 的键是 `<类名>.<方法名>`，单态化那趟按
# 调用点的 `self` 类型收实例，于是抄过来那份在子类上**自己生成一份**、读的是子类的字段。
# 子类覆盖了同名方法时，父类那份挪到 `__super__<名字>` 上 —— `super().<名字>(…)` 落到它。
# `isinstance` 沿 `base` 链往上找（编译期就答得出来）。
# **多态没接**：把子类装进父类那格变量、或者混在一张表里，那两档要 vtable 或箱子 ——
# 撞上了当场报"这张表里装着 named / named —— 合不成一格"。
class Animal:
    def __init__(self, name: str):
        self.name = name

    def speak(self) -> str:
        return "..."

    def intro(self) -> str:
        return self.name + " says " + self.speak()


class Dog(Animal):
    def __init__(self, name: str, tricks: int):
        super().__init__(name)
        self.tricks = tricks

    def speak(self) -> str:
        return "woof"

    def brag(self) -> str:
        return super().speak() + "/" + str(self.tricks)


a = Animal("thing")
d = Dog("rex", 2)
print(a.speak(), a.intro())
print(d.speak(), d.intro(), d.brag())
print(d.name, d.tricks, len(d.name))
print(isinstance(d, Dog), isinstance(d, Animal), isinstance(a, Animal), isinstance(a, Dog))


