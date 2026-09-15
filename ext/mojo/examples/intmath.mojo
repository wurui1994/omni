# ext/mojo/examples/intmath.mojo —— 与 lua / go / V / nim 那几份 intmath **同一件事**
#
# 期望输出逐行相同：15 / 120。

fn sumto(n: Int) -> Int:
    var acc = 0
    var i = 1
    while i <= n:
        acc = acc + i
        i = i + 1
    return acc

fn fact(n: Int) -> Int:
    if n == 0:
        return 1
    return n * fact(n - 1)

fn main():
    print(sumto(5))
    print(fact(5))
