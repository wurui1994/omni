# ext/mojo/examples/index.mojo —— 与另外五门那几份 index 例子**同一件事**
#
# 期望输出逐行相同：10 / 30 / 45。
# Mojo 的 `[10, 20, 30]` 与 lua 的 `{…}`、go 的 `[]int{…}`、nim 的 `@[…]`
# 落**同一格** list-new。

fn main():
    var xs = [10, 20, 30]
    print(xs[0])
    print(xs[2])
    xs[1] = 5
    var s = 0
    var i = 0
    while i < 3:
        s = s + xs[i]
        i = i + 1
    print(s)
