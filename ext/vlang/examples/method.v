// ext/vlang/examples/method.v —— **方法那一族**（与 nim / go 那两份同一件事）
//
// 期望输出（家族里所有语言、所有后端逐行相同）：3 / 9 / 3。
//
// V 的接收者写在声明里（`fn (p Point) total() int`）—— 与 go 一字不差：
// 图上只是**多一格实参的普通函数**，方法不是一格新节点，分派也不查表。
// 第三行故意把同一件事写成字段算术：方法算出来的 3 与手写的 `p.x + p.y` 是同一个数。

struct Point {
	x int
	y int
}

fn (p Point) total() int {
	return p.x + p.y
}

fn (p Point) scaled(k int) int {
	return p.total() * k
}

fn main() {
	p := Point{
		x: 1
		y: 2
	}
	println(p.total())
	println(p.scaled(3))
	println(p.x + p.y)
}
