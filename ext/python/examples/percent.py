"""老式的 `%` 格式化（`"%d 个" % n`）。

python 这一族照的是 C 的 printf，而方言里那几格串算子本来就是 C 的那几个转换：
`sfix` = `%.*f`、`ssci` = `%.*e`、`sgen` = `%.*g`、`sbase` = `%x` / `%o`（小写，
要大写裹一层 `supper`）。所以 adapter 不自己算数字的文本，只管切格式串、挑算子、补宽度。

**格式串要是编译期的字面量** —— 转换字母决定发哪一格算子；运行期的格式串要一台运行期的
格式化机器（那是 CPython 的 `unicodeobject.c` 里那一大段），没接。
"""

n = 42
x = 3.14159
s = "omni"

print("%d 个" % n)
print("%s=%s" % (s, n))
print("%s 与 %s 与 %s" % (1, 2.5, True))

print("%.2f" % x)
print("%f" % x)
print("%e" % x)
print("%g" % x)
print("%.0f %.4f" % (x, x))

print("%x %X %o" % (255, 255, 8))
print("100%% done" % ())

# 宽度与标志：`-` 靠左、`0` 补零（**补在符号后头**）、`+` 非负也带号
print("[%5d]" % n)
print("[%-5d]" % n)
print("[%05d]" % n)
print("[%05d]" % -12)
print("[%+d] [%+d]" % (5, -5))
print("[%8.3f]" % x)
print("[%-8.3f]" % x)
print("[%08.3f]" % x)
print("[%08.3f]" % -x)

# 宽度不够时不截断（python 的规矩）
print("[%2d]" % 12345)

print("[%.3s]" % "abcdef")
print("[%.9s]" % "abc")
print("[%10s] [%-10s]" % ("hi", "hi"))

print("%r %r" % (s, 2.5))

# 拼在一起用
for k, v in zip(["a", "bb"], [1, 22]):
    print("%-4s %3d" % (k, v))

# ---- `%` 的**类型**也是串 -----------------------------------------------------
# 发射那一侧早就在算右边之前拦了（右边是一格元组，这一层没有元组那一档），可**类型**那一侧
# 从前漏了：`o === '%'` 落到"两边都是数"那一条上、答 real。平时看不出来（拼进 print 里
# 就没人问它的类型），`return` 那一处一问就露：报"要返回 real，给的是 string"。
def row(name, qty, price):
    return name.ljust(8) + str(qty).rjust(4) + ("%8.2f" % price)


print(row("widget", 3, 2.5))
print(row("bolt", 12, 0.125))


def pct(x):
    return "%d%%" % x


print(pct(30), len(pct(5)))
