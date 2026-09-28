"""异质的表：一格里装什么运行期才知道 —— 退到 dyn，不要标注。

这一份钉的是「类型推不出来也没关系」这条：`[1, "two", 3.5, True]` 在 python 里天经地义，
方言那一侧落成 `(arr dyn)`（表是静态的一格数组，元素是装了箱的动态值），印出来按
`(dtag …)` 逐档分派。三条腿（interp / js / c）与 python3 逐字节相同。
"""

xs = [1, "two", 3.5, True]

for v in xs:
    print(v)

print(xs)
print(len(xs))
print(xs[0])
print(xs[-1])

# 空表当条件：箱子里那几档的真值也按标签分派
ys = [0, "", 7]
for y in ys:
    if y:
        print("真", y)
    else:
        print("假", y)

# 箱子里装着串、又在 repr 那一侧时，引号与转义**与静态那条同一份实现**
# （`lib/str.py` 的 `_str_repr`）。从前这儿只加一对单引号，`"a'b"` 印出来是三个单引号，
# `"t\n"` 里那一格换行原样印出去（把一行折成两行）。
zs = [1, "a'b", "t\n", 2.5, True]
print(zs)
print(repr(zs[1]), str(zs[1]), repr(zs[2]))
