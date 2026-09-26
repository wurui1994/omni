# ext/python/examples/comprehensions.py —— 推导式
#
# `[e for x in xs if p]` / `{k: v for …}` / `(e for x in xs)` —— **方言一格新算子都不加**：
# `anew` / `apush` / `dnew` / `dset` 加一趟 `while` 就够，与 `builtins.js` 里 sum / sorted
# 那几格同一条办法（现场发一趟循环）。
#
# 两条要紧的口径：
#   1. **循环变量不漏到外头**。python 3 里推导式有自己的作用域；我们的办法是把那个名字
#      在推导式里临时改成一格新名（`C.alias`），发完指回去。所以下面 `x` 那一处
#      推导式前后都还是 99。不改名的话外头那个 x 与里头的会被合成一格 dyn —— 那是真会答错。
#   2. 生成器表达式当成"**立刻算完的一张表**"（python 是懒的）。差别只在无穷的生成器
#      （我们会挂住）与副作用的次序上露头；`sum(x * x for x in xs)` 这类用法两边一样。
#
# 目标位收一格名字，或者**两格名字**配 `enumerate` / `zip` / `d.items()` ——
# 与 `for` 语句那一侧同一份名单（python 里它们交的是元组，而这一层没有元组那一档，
# 可这三种落下去都只是一趟下标循环）。


def evens(n: int) -> list[int]:
    return [i for i in range(n) if i % 2 == 0]


# 模块级也要走得通。量过一处会答错的地方：模块级那张表按 **python 的名字**存
# （`lookup` 的兜底那一句用的是原名），而改名只换了 `ref` 里那一格 —— 所以推导式
# 必须**自己开一层作用域**，不然 `x` 在这一行查不到，`SEED` 那格全局就没声明。
BASE = [1, 2, 3]
SEED = [x * 10 for x in BASE]
SEEN = {str(x): x for x in BASE}


def main():
    print(SEED, SEEN)
    xs = [1, 2, 3, 4]

    # 最常见的三种
    print([x * x for x in xs])
    print([x for x in xs if x % 2 == 0])
    print({str(x): x * x for x in xs})

    # 走一遍串 / range / 字典
    print([c for c in "abc"])
    print([i * i for i in range(5)])
    ages = {"ann": 31, "bob": 24}
    print([k for k in ages])
    print([ages[k] for k in ages])

    # 两格目标
    print([i * v for i, v in enumerate(xs)])
    print([i for i, v in enumerate(xs, 1)])
    print([a + b for a, b in zip(xs, [10, 20])])
    print([k + "=" + str(v) for k, v in ages.items()])
    print({v: k for k, v in ages.items()})

    # 几个 if（挨着写就是且）
    print([n for n in range(20) if n % 2 == 0 if n % 3 == 0])

    # 嵌套的 for（后一格的可迭代可以用前一格的目标）
    grid = [[1, 2], [3, 4, 5]]
    print([c for row in grid for c in row])
    print([a * b for a in [1, 2, 3] for b in [10, 20]])

    # 表里套表
    print([[y for y in range(x)] for x in range(4)])

    # 生成器表达式：sum / any / all 收它
    print(sum(x * x for x in xs))
    print(any(x > 3 for x in xs), all(x > 0 for x in xs))

    # 推导式出来的表接着用
    print(sorted([x for x in [3, 1, 2]]), max([x * 2 for x in [3, 1, 2]]))
    print(len([x for x in range(5)]))
    total = 0
    for v in [x + 1 for x in range(4)]:
        total += v
    print(total)

    # 元素位上可以写方法调用、函数调用
    words = ["hi", "there"]
    print([w.upper() for w in words], [len(w) for w in words])
    print([evens(n) for n in [3, 5]])

    # 循环变量不漏：这两处的 x 是两格不同的东西
    x = 99
    print([x * 10 for x in xs], x)

    # 空的可迭代 → 空表 / 空字典
    empty: list[int] = []
    print([v * 2 for v in empty], {str(v): v for v in empty})


main()

# ---- 实参位置上的 range，以及 isinstance 收一格元组 ---------------------------
# `range` 当值用本身没接（python 印 `range(0, 3)`，铺成一张表就印错了），可
# `list(range(3))` / `sorted(range(3))` / `reversed(range(4))` / `sum(range(5))` 这几种
# 写法只是"要一串数" —— 所以按**吃序列的那一格名单**放行（`print(range(3))` 照旧不接）。
print(list(range(3)), list(reversed(range(4))), sum(range(5)))
print(sorted(range(3)), max(range(1, 4)), min(range(2, 5)), len(list(range(6))))
print(any(v > 1 for v in range(3)), all(v >= 0 for v in range(3)))
print([v * 2 for v in range(4)], [v for v in reversed(range(3))])

# `isinstance(x, (A, B))` —— 一格元组就是"哪一格都算"（逐格问一遍再 or 起来）。
# 那一格值要问好几遍，所以只收名字或字面量。
n = 7
r = 1.5
t = "s"
print(isinstance(n, (int, float)), isinstance(r, (int, float)), isinstance(t, (int, float)))
print(isinstance(t, (str, int)), isinstance(n, (str,)), isinstance(1, (int, float)))
