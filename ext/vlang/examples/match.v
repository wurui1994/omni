// ext/vlang/examples/match.v —— **`match` 落一条 branch 链**（V 独一份的家族）
//
// 期望输出：10 / 20 / 30 / 200。
//
// 与 go 的 `switch.go` 是同一件事（**没有隐式贯穿**，所以不给它开节点），但 V 多压一样
// go 没有的：**match 既是语句也是表达式**，而这两件事在图上不同形 ——
//   * 语句位置：主语落一格 bind（只算一次），各支的体是一格 region；
//   * 表达式位置：每一支要交出一个**值**，而 bind 摆不进表达式位置 ——
//     所以那一路把主语原样抄进每一格比较（只接主语是名字或常量的），
//     而且**必须有 `else`**：掉出去那一路没有值。
//
// `1, 2` 那种一支几个值落 `lazyOr`（第二格 lazy），与 `||` 同一格 branch。

module main

fn label(n int) int {
	mut r := 0
	match n {
		1 { r = 10 }
		2, 3 { r = 20 }
		else { r = 30 }
	}
	return r
}

fn main() {
	println(label(1))
	println(label(3))
	println(label(9))
	x := 2
	y := match x {
		1 { 100 }
		2 { 200 }
		else { 300 }
	}
	println(y)
}
