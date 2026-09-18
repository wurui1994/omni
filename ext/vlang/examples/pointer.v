// ext/vlang/examples/pointer.v —— **`&T{…}` 与图上的引用正好重合**（与 go 那一份同一族）
//
// 期望输出：11 / 20 / 5 / 20。
//
// V 的语料里 `&ast.Ident{…}` 这种写法压倒性地多（`addr` 是 V 那一栏最高的一堵墙），
// 而它要的东西图上早就有：记录是**引用**。所以这一格落的是那一格 record-new 本身，
// 图上一格新节点也没加。
//
// V 与 go 差的两处写法都归这门语言的映射：
//   * 改一格字段要 `mut`（`mut p := &Point{…}`）—— `mut` 那一格不产生代码，拆一层就走；
//   * 传给函数写成 `bump(mut p)`（go 那边是 `bump(p)`）。
//
// **`&x` 里 x 已经是一格 struct 的那一半后来也接上了**（末两行判着）：图上的记录就是引用，
// 所以 `s := &r` 之后 `s.x = 9` 改的就是 r 那一格 —— 与 `&T{…}` 逐字同理。
//
// 仍旧当场报的与 go 那份一样：`&x` 里 x 是标量 / 类型没写在语法上，与光秃秃的 `*p` 当值用。

module main

struct Point {
mut:
	x     int
	other int
}

fn bump(mut p Point) {
	p.x = p.x + 1
}

fn main() {
	mut p := &Point{
		x: 10
		other: 5
	}
	bump(mut p)
	println(p.x)
	mut q := p
	q.x = 20
	println(p.x)
	println(p.other)
	println(q.x)
	mut r := Point{
		x: 7
		other: 1
	}
	mut s := &r
	s.x = 9
	println(r.x)
}
