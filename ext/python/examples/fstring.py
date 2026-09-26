"""f-string —— 替换字段里那段表达式**用同一张 LR 表再解析一遍**。

整份 f-string 在词法那一层是**一个记号**（这套 GLR 的词法器是一张 DFA，没有起始条件
也没有栈，所以不走 PEP 701 那种 FSTRING_START / MIDDLE / END 三族记号）。adapter 把正文
按替换字段切开，每一段的原文裹成 `(…)` 再解析一趟 —— jnc 那一门的 `$(…)` 走的是同一条。

接了的：`{expr}`、`{expr!r}` / `{expr!s}`、`{{` 与 `}}`，以及**格式说明那套微语言的一块**
（填充 + 对齐 `< > ^`、符号 `+ -` 与空格、`0`、宽度、`.精度`、类型 `d f s x X o b`）。
没接的：`#`（`0x` 前缀）、`,`（千分位）、`=`（符号后填充）、`e` / `g` / `%` / `n`、
宽度或精度写成 `{}`（从实参来）、`{x=}` 自文档、`!a`，
以及**里外同一种引号**（`f"{d["k"]}"`，PEP 701 放开的那一格 —— 那是词法层的事）。
"""

name = "omni"
n = 3
x = 2.5

print(f"hello {name}")
print(f"{n} + {n} = {n + n}")
print(f"{x:.2f}")
print(f"{x:.0f} {x:.4f}")
print(f"{name!r}")
print(f"{name!s}")
print(f"{{literal}}")
print(f"a{n}b{name}c")

xs = [1, 2, 3]
print(f"first={xs[0]} last={xs[-1]} len={len(xs)}")

d = {"k": 7}
print(f"d[k]={d['k']}")


def twice(v):
    return v * 2


print(f"twice({n})={twice(n)}")
print(f"{n > 2} {n == 3}")

# 相邻串自动拼接：一边是 f-string、一边是普通串
print(f"{n}" "-tail")
print("head-" f"{n}")

# 箱子（dyn）也印得出来
b = 1
b = "two"
print(f"b={b}")
b = 3.5
print(f"b={b}")

# ---- 格式说明那套微语言 -------------------------------------------------------
print(f"{3.14159:.2f}|{3.14159:>10.3f}|{3.14159:<10.3f}|")
print(f"{42:5d}|{42:05d}|{42:<5d}|{42:^7d}|")
print(f"{42:x} {255:X} {42:b} {42:o}")
print(f"{'hi':^6}|{'hi':>6}|{'hi':<6}|{'hi':*^8}|")
print(f"{5:+d} {-5:+d} {5:+.2f} {-5.5:+.2f}")
print(f"{5: d} {-5: d}")
# `:.N` 落在串上是**截到 N 个字符**（不是小数位）
print(f"{'abcdef':.3}|{'ab':.5}|")
print(f"{1.5:8.1f}|{-1.5:08.2f}|")
# 空的格式说明与没写是一回事
print(f"{7}|{7:}|{'x'}|")
w = 3
z = 2.5
print(f"{w:03d} {z:.1f} {w:>4} {z:<8}|")
# 居中时**余数放右边**（python 就是这么摆的）
print(f"{'x':^4}|{'x':^5}|")

# ---- str.format() —— 同一套格式说明，另一种写法 -------------------------------
# 模板要是**串字面量**（替换字段得在编译期拆开）。说明那一段直接借 f-string 那一份：
# 两处本来就是同一套规矩，各写一遍必然对不上。
print("{} and {}".format(1, "x"))
print("{0}-{1}-{0}".format("a", "b"), "{1}{0}".format(1, 2))
print("{:>5}|{:<5}|{:^5}|".format("ab", "cd", "ef"))
print("{:05d} {:.2f} {:x}".format(42, 3.14159, 255))
print("{:+.3f} {:*^7}".format(2.5, "hi"), "{:8.3f}|".format(1.0 / 3.0))
print("{{}} {}".format(7), "{!r} {!s}".format("q", "q"))
print("no fields".format(), "{}".format([1, 2]), "{}".format(True))

# ---- 段里带副作用：次序要按源码来 --------------------------------------------
# 凡是"把几段拼成一个表达式"的地方，段里带的那几句会被提到整句最前头，于是**后面那一段的
# 活儿跑在前面那一段的副作用之前**，而 python 是从左到右算的。量到的原话：
# `f"{xs.pop()} {xs}"` 答 `2 [1, 2]`（python 是 `2 [1]`）—— 转 `xs` 那趟循环跑在
# `apop` 之前。四种拼法（f-string / `+` / `%` / `.format()`）现在都按次序钉住。
xs = [1, 2]
print(f"{xs.pop()} {xs}")
ys = [3, 4]
print(str(ys.pop()) + " " + str(ys))
zs = [5, 6]
print("%s %s" % (zs.pop(), zs))
ws = [7, 8]
print("{} {}".format(ws.pop(), ws))
vs = [9, 10]
print(f"{vs.pop()}/{vs.pop()}/{vs}")
