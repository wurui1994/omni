// ext/vlang/examples/conv.v —— 与 go / freebasic 那两份 conv **同一件事**
//
// 期望输出逐行相同：2 / 3.5。
// V 的 `int(x)` / `f64(x)` 在树上与调用同形（`(call (name int) …)`）——
// 分开它们靠的是"这名字是不是一格类型"，映射里一张表说；节点只收 `to` 那格附属。

fn main() {
	println(int(7.0 / 3.0))
	println(f64(7) / 2)
}
