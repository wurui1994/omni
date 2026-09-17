# ext/mojo/examples/assertok.mojo —— 与 ext/vlang/examples/assertok.v **同一件事**
#
# 期望输出逐行相同：3 / 7。
#
# 两门的 assert 在树上**不同形**（V 是语句形状、mojo 是 Python 形状：消息直接跟在逗号后面，
# 不带 `(msg …)` 那一层），落到的却是**同一格节点** —— 又一个"写法归语言、格子归节点"。
#
# 这一份里的断言都是成立的（不成立那一路的判据在 tests/graph/assertfail.js）。

def twice(n: Int) -> Int:
    assert n > 0
    return n * 2

def main():
    var x = 3
    assert x == 3
    assert x > 1, "x 要大于 1"
    print(x)
    assert twice(x) == 6, "twice 坏了"
    print(7)
