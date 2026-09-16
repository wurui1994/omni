# ext/mojo/examples/record.mojo —— 与另外八门那几份 record **同一件事**
#
# 期望输出逐行相同：1 / 5 / 6。
#
# mojo 的形状与 FB 一样是"**字段表在类型上**"，但它有构造式：`@value` 那个装饰器
# 正是 mojo 生成 `__init__` 的写法，所以 `Point(1, 2)` 是**按字段顺序**的构造 ——
# 那就是 record-new 那一格（字段顺序从 struct 那几行登记，见 ext/mojo/tograph.js 的 STRUCTS）。
#
# 落到图上仍然只有现成的三格（record-new / field-get / field-set），一格新节点都没加。
# 自己写 `fn __init__` 的那种**不收**：那要方法分派（账上另一条），撞上会干净地报错。

@value
struct Point:
    var x: Int
    var y: Int

fn main():
    var p = Point(1, 2)
    print(p.x)
    p.y = 5
    print(p.y)
    print(p.x + p.y)
