// ext/vlang/examples/push.v —— **`arr << x` 是列表追加**（V 独一份的家族）
//
// 期望输出：30 / 40 / 100。
//
// 这一格是**账上算出来的，而且那笔账原来记错了**：`bench/tograph.js` 印的是
// "这个算子还没接：`<<`"（V 那一栏 98 份），看着像位运算 —— 抽一遍语料才知道
// V 自己的编译器里 3228 行含 `<<`，其中只有词法表那几行是位移，其余全是
// `nodes << x` / `lines << continued` 这种**数组追加**。
//
// 落的是**一格内建**（`prim push`）而不是一格节点：两格实参都是普通的值，没有
// "哪一格是什么角色"要分 —— 与 `len` 同一类，是列表上的一个库函数。
// （这正是它与 `assert` 的差别：那一格的消息是**自己的端口**，所以那一格才是节点。）

module main

fn main() {
	mut xs := [10, 20]
	xs << 30
	xs << 40
	println(xs[2])
	println(xs[3])
	mut acc := 0
	for i := 0; i < 4; i++ {
		acc = acc + xs[i]
	}
	println(acc)
}
