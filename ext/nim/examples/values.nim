## ext/nim/examples/values.nim —— 与 ext/sbcl/examples/values.lisp **同一件事**
##
## 期望输出逐行相同：3 / 7。
## nim 没有 CL 那种 `values` 形式，它用**元组**：`return (a, b)` 与 `let (lo, hi) = f()`。
## 两种写法落同一对节点 —— `(a, b)` 是生产侧的 `values`、`(lo, hi)` 是消费侧的一串 `pick`
## （树上那格标签叫 `untuple`，正好把"N 个名字对 1 个右值"说清了）。

proc minmax(a: int, b: int): (int, int) =
  if a < b:
    return (a, b)
  return (b, a)

let (lo, hi) = minmax(7, 3)
echo lo
echo hi
