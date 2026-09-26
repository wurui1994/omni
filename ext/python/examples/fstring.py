"""f-string —— 替换字段里那段表达式**用同一张 LR 表再解析一遍**。

整份 f-string 在词法那一层是**一个记号**（这套 GLR 的词法器是一张 DFA，没有起始条件
也没有栈，所以不走 PEP 701 那种 FSTRING_START / MIDDLE / END 三族记号）。adapter 把正文
按替换字段切开，每一段的原文裹成 `(…)` 再解析一趟 —— jnc 那一门的 `$(…)` 走的是同一条。

接了的：`{expr}`、`{expr!r}` / `{expr!s}`、`{expr:.Nf}`、`{{` 与 `}}`。
没接的：别的格式说明（`:>10`、`:,`、`:x` —— 那是一整套微语言）、`{x=}` 自文档、`!a`，
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
