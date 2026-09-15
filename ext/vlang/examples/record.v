// ext/vlang/examples/record.v —— 与 go / lua 那两份 record 例子**同一件事**
//
// 期望输出逐行相同：1 / 5 / 6。
// V 的 struct 字段默认不可变，所以这一份多两个记号（`mut:` 与 `mut p`）——
// 可变性是**附属**（挂在声明上那一类），不是新节点。

struct Point {
mut:
	x int
	y int
}

fn main() {
	mut p := Point{
		x: 1
		y: 2
	}
	println(p.x)
	p.y = 5
	println(p.y)
	println(p.x + p.y)
}
