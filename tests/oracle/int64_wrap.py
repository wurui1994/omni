"""int64_wrap.omni 的参照实现。

Python 的整数是任意精度的，所以这里显式把 ADR-0005 的规格算一遍：
  - 所有算术结果回绕到有符号 64 位
  - `/` 向零截断，`%` 的符号跟随被除数（C 语义，不是 Python 的地板除）
  - 移位计数取 & 63
参照实现刻意不"照抄"编译器的实现方式，而是照文档重新表达一次。
"""

M = 1 << 64
HALF = 1 << 63


def w(x):
    """回绕到 int64"""
    x &= M - 1
    return x - M if x >= HALF else x


def tdiv(a, b):
    q = abs(a) // abs(b)
    if (a < 0) != (b < 0):
        q = -q
    return w(q)


def tmod(a, b):
    return w(a - w(tdiv(a, b) * b))


vals = [
    0, 1, -1, 2, -2, 7, -7,
    3037000500, -3037000500,
    9223372036854775807, -9223372036854775807 - 1,
    4294967296, -4294967296,
    1000000007, -1000000007,
]
shifts = [0, 1, 7, 31, 32, 63, 64, 65, 127]

for a in vals:
    for b in vals:
        print(w(a + b))
        print(w(a - b))
        print(w(a * b))
        print(w(a & b))
        print(w(a | b))
        print(w(a ^ b))
        if b != 0:
            print(tdiv(a, b))
            print(tmod(a, b))

for a in vals:
    print(w(-a))
    print(w(~a))
    for k in shifts:
        print(w(a << (k & 63)))
        print(w(a >> (k & 63)))

acc = 1
for a in vals:
    acc = w(acc * 31)
    acc = w(acc + a)
    print(acc)

i = 9223372036854775807
i = w(i + 1)
print(i)
i = w(i - 1)
print(i)
