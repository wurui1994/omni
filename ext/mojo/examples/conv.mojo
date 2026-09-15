# ext/mojo/examples/conv.mojo —— 与 go / V / nim / freebasic 那几份 conv **同一件事**
#
# 期望输出逐行相同：2 / 3.5。

fn main():
    print(Int(7.0 / 3.0))
    print(Float64(7) / 2)
