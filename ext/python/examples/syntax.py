# ext/python/examples/syntax.py —— 语法那几处**容易读歪的形状**，一份文件一网打尽。
#
# 这一份不是"演示 python 怎么写"，是**语法的回归语料**：参考树不在的机器上，
# `bench/grammars.js python` 也还量得出一个数。每一段后面都注明它挡的是哪一处。
from __future__ import annotations

import os
import os.path as osp
from collections import OrderedDict, defaultdict
from . import sibling
from .. import parent
from .mod import thing as renamed

# PEP 810（3.16）：`lazy` 是软关键字 —— 标准库里 71 份在用
lazy import json
lazy from typing import IO, Self

# 软关键字当普通名字用：这四个词进了关键字表，得从 `sname` 那条放回来
type = int
match = os.path.join
case = {"type": type, "match": match}
lazy = [type, match]
print(type(1), match("a", "b"), case["type"], lazy[0])

# PEP 695：类型别名与类型形参
type Alias = list[int]
type Pair[T] = tuple[T, T]
type WithBound[T: (int, str), *Ts, **P] = dict[T, int]


def identity[T](x: T) -> T:
    return x


class Box[T: object]:
    __slots__ = ("value",)

    def __init__(self, value: T, /, *, strict: bool = False) -> None:
        self.value = value
        self.strict = strict

    @property
    def doubled(self) -> T:
        return self.value + self.value

    @staticmethod
    def of(*args: int, **kwargs: str) -> "Box[int]":
        return Box(sum(args) + len(kwargs))


# 元组：`a` 不是元组，`a,` 是，`a, b` 是 —— 这三格在 CST 里必须分得开
one = 1
single = (1,)
bare_single = 1,
pair = 1, 2
trailing = (1, 2,)
empty = ()
nested = ((1, 2), (3, 4))
a, b = pair
(c, d), e = nested[0], 9
*head, last = [1, 2, 3]
f = g = h = 0
f += 1
h **= 2
annotated: int = 3
just_annotated: dict[str, int]

# 显示字面量与推导式。海象在显示里合法（`(a, b := c)`）；元素位收 star（PEP 798）
xs = [i * i for i in range(10) if i % 2 == 0]
ys = {k: v for k, v in case.items()}
zs = {i for i in xs}
gen = (i for i in xs if i)
flat = [*xs, *ys]
starred_comp = [*p for p in (xs, flat)]
walrus_in_tuple = (0, (n := len(xs)), n + 1)
sub = xs[m := 1]
nested_comp = [y for row in nested for y in row if y > 1]
sliced = xs[1:5:2], xs[::-1], xs[:], xs[None:2]

# lambda 的形参不带括号 —— `lambda x: e` 里那个冒号归 lambda，不是标注
key = lambda item, *rest, flag=False, **kw: (item, flag)
cond = "yes" if one else "no"
chained = 0 < one <= 2 != 3
logical = not (one in xs) and (one is not None or bool(xs))


def generators():
    received = yield 1
    yield from range(3)
    return received


async def coro(items):
    async with open("/dev/null") as fh:
        pass
    async for item in items:
        await identity(item)
    return [x async for x in items]


# with：不带括号、带括号（至少一格 as）、多项
def contexts(p1, p2):
    with open(p1) as fh:
        pass
    with open(p1), open(p2):
        pass
    with (
        open(p1) as one_f,
        open(p2) as two_f,
    ):
        return one_f, two_f


# except：单个、PEP 758 的不带括号多个、带括号多个、PEP 654 的 except*
def handlers(x):
    try:
        return 1 / x
    except ZeroDivisionError as exc:
        raise ValueError("zero") from exc
    except TypeError, AttributeError:
        return None
    except (KeyError, IndexError) as exc:
        return exc
    except* OSError as eg:
        return eg
    else:
        return 0
    finally:
        del x


# match（PEP 634）：模式这儿是借表达式的语法收的
def classify(node):
    match node:
        case 0 | 1 | 2:
            return "small"
        case [first, *rest] if rest:
            return first
        case {"kind": kind, **extra}:
            return kind, extra
        case Box(value=v):
            return v
        case str() as s:
            return s
        case _:
            return None


# 数：整数没有上界，虚数、下划线分隔、各种进制；`x.__len__()` 里的 `.__` 不是浮点数
nums = (0, 1_000_000, 0xFF_FF, 0o777, 0b1010_1010, 1e10, 1.5e-3, .5, 1., 3j, 2.5J)
big = 2 ** 1000
print(nums[0].__class__, big.bit_length())

# 串：相邻自动拼接、各种前缀、三引号、原始串里的反斜杠
text = "one" "two" 'three'
raw = r"\d+\s*" r'\\'
byte = b"bytes" rb"\x00"
doc = """三引号里可以有 " 与 "" 和 \" """
fmt = f"{one}{pair!r:>10} {'nested single quotes'}"
tmpl = t"模板串（3.14）：{one}"

# 反斜杠续行：整个吃掉，缩进那一步看不见它
total = 1 + \
    2 + \
    3

# 标识符许 Unicode（PEP 3131）
名字 = "ünïcödé"
café = len(名字)


def main():
    global one
    one = 2

    def inner():
        nonlocal_target = 0

        def innermost():
            nonlocal nonlocal_target
            nonlocal_target += 1

        innermost()
        return nonlocal_target

    assert inner() == 1, "inner 应当加一"
    for i in range(3):
        if i == 1:
            continue
        elif i == 2:
            break
        else:
            pass
    else:
        pass
    while total:
        break
    else:
        pass
    return 0


if __name__ == "__main__":
    main()
