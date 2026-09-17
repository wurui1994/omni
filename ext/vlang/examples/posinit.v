// ext/vlang/examples/posinit.v —— **位置型结构字面量**（V 独一份的家族）
//
// 期望输出：3 / 11 / 16。
//
// `Point{1, 5}` 只给了**值**，而 `record-new` 那一格要的是**字段名** —— 所以名字与顺序
// 从**声明**来（`STRUCTS` 那张表）。这条路子不是这一门特有的：mojo 的 `@value struct`、
// CL 的 `defstruct`、Scheme 的 `define-record-type`、FB 的 `Type … End Type` 都是同一条
// "**名字与顺序从声明来**"。V 这一门的特殊之处只有一样：**同一条产生式两种写法** ——
// 位置型出 `(positional …)`、带名字的出 `(f 名 值)`，混着写 V 自己也不许（这儿当场报）。
//
// 声明不在这一份文件里、或者那个 struct 有**嵌入字段**（嵌入的那一格在构造顺序里占几格
// 要展开被嵌类型才知道），都当场报 —— 不猜。

module main

struct Point {
	x int
	y int
}

fn main() {
	p := Point{1, 5}
	q := Point{x: 2, y: 6}
	println(p.x + q.x)
	println(p.y + q.y)
	mut r := Point{7, 8}
	r.y = 9
	println(r.x + r.y)
}
