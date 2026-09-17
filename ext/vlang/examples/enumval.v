// ext/vlang/examples/enumval.v —— **枚举的值 · Option 上的转换**（V 独一份）
//
// 期望输出：1 / 2 / 11 / 0 / 7 / 1。
//
// 枚举的**声明在图上是丢掉的**（类型不进图），可 `.red` / `Color.red` 这两种写法要拿到
// **值** —— 所以名字与值从**声明**登记（`ENUMS` / `EVARIANTS`），与"字段名与顺序从声明来"
// （`STRUCTS`）同一条路子。V 的值规则：默认从 0 数上去，写了 `= N` 就从那儿接着数。
//
// `.red` 那种短写法**类型从上下文来**，而上下文这一层看不见。办法与方法重名那一格同一条：
// 变体名在整份文件里唯一就用它，撞了当场报（不猜）。
//
// 末两行是 `?int(…)`：这一批把 Option 那一层**类型丢掉了**（`ext/vlang/SPEC.md` §五第 1 项），
// 所以 `?int(7)` 就是 7、`?int(none)` 就是 nil。

module main

enum Color {
	red
	green
	blue
}

enum Level {
	low = 10
	high
}

fn main() {
	println(Color.green)
	c := Color.blue
	println(c)
	println(Level.high)
	d := .red
	println(d)
	x := ?int(7)
	println(x)
	y := ?int(none)
	if y == none {
		println(1)
	} else {
		println(0)
	}
}
