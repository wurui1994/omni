# ext/python/examples/try_min.py —— 异常那一刀的最小闭环
#
# try/except/else/finally + raise + 内建错误（除零/缺键/下标越界）都可捕获。
# 跑法与其它例子同一条：omni run ext/python/examples/try_min.py（我们的前端，
# 不借本机 python3、不借 CPython ceval）。
def div(a, b):
    return a / b


try:
    x = div(1, 0)
except ZeroDivisionError as e:
    print("caught", e)

d = {}
try:
    print(d["nope"])
except KeyError:
    print("no key")

xs = [1, 2, 3]
try:
    print(xs[9])
except IndexError:
    print("no index")

try:
    raise ValueError("boom")
except ValueError as e:
    print("got", e)

try:
    print("body")
except ValueError:
    print("not here")
else:
    print("else ran")
finally:
    print("fin ran")

try:
    try:
        raise TypeError("inner")
    except ValueError:
        print("not mine")
except TypeError as e:
    print("outer got", e)

for v in (2, 0):
    try:
        print(div(10, v))
    except ZeroDivisionError:
        print("div by zero")
