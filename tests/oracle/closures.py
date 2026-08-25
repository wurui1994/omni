"""closures.omni 的参照实现。

注意 `lambda x, i=i:`：Python 的 lambda 捕获的是**变量**，循环结束后所有闭包都会看到
最后一轮的 i（经典的晚绑定坑）。Omni 规定捕获按值，所以对照实现必须用默认参数
把当轮的值钉住 —— 这一行就是两种语义的差别本身。
"""

def step(x):
    return x + 1


def adder(n):
    return lambda x, n=n: x + n


fs = []
i = 0
while i < 10:
    fs.append(lambda x, i=i: x * 10 + i)
    i += 1
j = 0
out = ""
while j < 10:
    out = out + str(fs[j](j)) + ","
    j += 1
print(out)

base = 1
f = lambda x, base=base: x + base
print(f(0))
base = 1000
print(f(0))

made = []
k = 0
while k < 5:
    g = adder(k * k)
    made.append(g(100))
    k += 1
print(len(made))
s = 0
for m in made:
    s += m
print(s)


def fold(xs, t):
    acc = 0
    for x in xs:
        acc += t(x)
    return acc


print(fold([1, 2, 3, 4, 5], step))
print(fold([1, 2, 3, 4, 5], lambda x: x * x))
print(fold([1, 2, 3, 4, 5], adder(-1)))

sink = []


def push(x):
    sink.append(x * 2)


n = 0
while n < 6:
    push(n)
    n += 1
print(len(sink))
dump = ""
for v in sink:
    dump = dump + str(v) + "|"
print(dump)


def outer(a):
    return lambda b, a=a: (a + b) * 2


print(outer(3)(4))
print(outer(-5)(5))
