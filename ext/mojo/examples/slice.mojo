# ext/mojo/examples/slice.mojo —— 与 go / V / nim 那几份 slice **同一件事**
#
# 期望输出逐行相同：20 / 30。
# mojo 的下标里装着一格 `(slice from to)` —— 取一格与取一段在树上分得清，不用回问类型。

fn main():
    var xs = [10, 20, 30, 40]
    var ys = xs[1:3]
    print(ys[0])
    print(ys[1])
