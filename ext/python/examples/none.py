"""`None` —— 标签是 `"null"` 的那一格 dyn。

方言这一层原先**写不出**"没有值"：`(null TYPE)` 要一格引用类型，而 `DynNull` 那个 OIR 节点
四条腿本来就都认（backend-c 的 `omni_dyn_null()`、backend-js 与 interp 的 `null`、MIR 的常量）
—— 缺的只是方言这一面的写法。于是加了一格 `(dnull)`，`None` 就有地方去了。

顺带解决的是"**可能没有值**"这一族：`def find(...)` 一支 return 一格数、一支 return None
—— 合成出来就是 dyn，不必写 `Optional[int]`，也不必报错要标注。
"""

x = None
print(x)
print(x is None)
print(x is not None)

x = 5
print(x)
print(x is None)


def find(xs, k):
    for v in xs:
        if v == k:
            return v
    return None


r = find([1, 2, 3], 2)
print(r)
print(r is None)
r = find([1, 2, 3], 9)
print(r)
print(r is None)

print(None == None)
print(None != None)

if x is not None:
    print("有值")

# `None` 的真值是假 —— 与空串 / 0 同一档
if not None:
    print("None 是假的")

# 异质的表里也躺得下
xs = [1, None, "a", None]
for v in xs:
    print(v, v is None)
print(xs)
