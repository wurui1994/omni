# ext/mojo/examples/values.mojo —— 与 CL / nim / V / Scheme 那几份 values **同一件事**
#
# 期望输出逐行相同：3 / 7。
#
# mojo 的多值是**元组**（`Tuple[Int, Int]` + `return (3, 7)`），消费侧是解包
# `var a, b = two()` —— 生产侧落一格 `values`、消费侧落一串 `pick`，
# 与 go/V 的多返回值、CL 与 Scheme 的 `values`、nim 的元组是**同一对节点**。
#
# 注意 mojo 只在头一格上写 `var`（`var a, b = …`）—— "是不是声明"看整张 targets，
# 那是这门语言的记号，不是图上的事。

fn two() -> Tuple[Int, Int]:
    return (3, 7)

fn main():
    var a, b = two()
    print(a)
    print(b)
