# ext/python/examples/basics.py —— 能跑起来的那一小片（这一刀的判据）
#
# 每一段都拿本机 python3 跑过，两边 stdout 逐字节相同（`node tests/python/run.js`）。

GREETING = "hello"
LIMIT = 5


def add(a: int, b: int) -> int:
    return a + b


def addf(a: float, b: float) -> float:
    return a + b


def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def classify(n: int) -> str:
    if n < 0:
        return "negative"
    elif n == 0:
        return "zero"
    else:
        return "positive"


def total(xs: list[int]) -> int:
    s = 0
    for x in xs:
        s += x
    return s


def main():
    print(GREETING, "world")
    print(add(2, 3), addf(1.5, 2.5))

    # 整数除法那三格：python 与 C 不一样的地方
    print(7 / 2, 7 // 2, 7 % 2)
    print(-7 / 2, -7 // 2, -7 % 2)
    print(2 ** 10, 3 ** 2)

    # 真值与比较链
    n = 3
    if 0 < n < LIMIT:
        print("in range")
    empty: list[int] = []
    if not empty:
        print("empty list is false")
    if not "":
        print("empty str is false")

    # 表
    xs = [4, 1, 3]
    xs.append(9)
    print(len(xs), xs[0], xs[-1])
    print(total(xs))
    xs[0] = 40
    print(xs[0])

    # 串
    s = "abcdef"
    print(len(s), s[0], s[-1], s[1:4])
    print(s.upper(), s.find("cd"))
    print("ab" * 3)
    print("x" in s, "cd" in s)

    # 字典
    d = {"one": 1, "two": 2}
    d["three"] = 3
    print(len(d), d["two"], "two" in d, "four" in d)

    # 循环
    acc = 0
    for i in range(LIMIT):
        if i == 2:
            continue
        acc += i
    print(acc)
    for i in range(3, 0, -1):
        print(i, end=" ")
    print()

    k = 0
    while k < 3:
        k += 1
    print(k)

    # 交换（右边先算完）
    a = 1
    b = 2
    a, b = b, a
    print(a, b)

    # 递归 + 三元
    print(fib(10), classify(-1), classify(0), classify(7))
    biggest = 10 if n < LIMIT else 20
    print(biggest, min(3, 7), max(3, 7), abs(-4))


if __name__ == "__main__":
    main()
