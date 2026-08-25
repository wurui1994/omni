import sys
sys.setrecursionlimit(100000)


def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def sum_to(n):
    acc = 0
    for i in range(1, n + 1):
        acc += i * i % 1000003
    return acc


print(fib(27))
print(sum_to(2000000))
