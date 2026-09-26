# ext/python/examples/control.py —— 控制流：break / continue / else 分支 / assert / global
#
# `continue` 在 `for` 里那一格是判据：`for` 落成方言的 `(while …)`，步进缀在体末尾的话
# `continue` 会跳过它当场死循环 —— 所以走的是标准 IR 的 `{kind:'for', post}`。

TICKS = 0


def bump(n: int) -> int:
    global TICKS
    TICKS = TICKS + n
    return TICKS


def first_even(xs: list[int]) -> int:
    for x in xs:
        if x % 2 != 0:
            continue
        return x
    return -1


def sum_until(xs: list[int], stop: int) -> int:
    s = 0
    for x in xs:
        if x == stop:
            break
        s += x
    return s


def gcd(a: int, b: int) -> int:
    while b != 0:
        t = b
        b = a % b
        a = t
    return a


def fizz(n: int) -> str:
    if n % 15 == 0:
        return "fizzbuzz"
    if n % 3 == 0:
        return "fizz"
    if n % 5 == 0:
        return "buzz"
    return str(n)


def main():
    xs = [1, 3, 4, 7, 8, 10]
    print(first_even(xs), first_even([1, 3]))
    print(sum_until(xs, 7), sum_until(xs, 99))

    # continue 在 range 循环里（步进不能被跳过）
    kept = 0
    for i in range(10):
        if i % 3 == 0:
            continue
        kept += 1
    print(kept)

    # 两层循环 + break（break 只跳出里头那一层）
    hits = 0
    for a in range(4):
        for b in range(4):
            if a * b > 4:
                break
            hits += 1
    print(hits)

    # while 里的 break
    n = 0
    while True:
        n += 1
        if n == 5:
            break
    print(n, gcd(48, 18), gcd(17, 5))

    line = ""
    for i in range(1, 16):
        line = line + fizz(i) + " "
    print(line)

    print(bump(2), bump(3), TICKS)

    assert TICKS == 5
    assert gcd(8, 12) == 4, "gcd 8 12 应当是 4"
    print("asserts ok")


main()
