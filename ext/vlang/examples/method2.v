// ext/vlang/examples/method2.v —— **两个类型上的同名方法**（mangle 那一刀的判据）
//
// 期望输出（家族里所有后端逐行相同）：3 / 12 / 30 / 7。
//
// 这一份钉的是 `docs/design/cross-file-methods.md` 那条 A 路：方法名**按接收者类型压平**
// （`Point.total` -> `Point__total`、`Box.total` -> `Box__total`）。原来那张平表
// （名字 -> 接收者类型）一撞名就当场报"重名要类型才分得开" —— 而 V 这么写是合法的，
// 语料里也到处是（`Ship.instance` 与 `GameObject.instance`）。
//
// 把 mangle 那一步删掉，这一份当场撞名：两格方法会落成同一个名字 `total`，
// 后一格盖掉前一格，第二行印出来的就不是 12。**接收者的类型从哪儿来**也在这儿判着：
// `b.total()` 里 `b` 的类型是 `Box{…}` 那句写着的（VARTYPE 只收语法上写着的那一档）。

struct Point {
	x int
	y int
}

struct Box {
	w int
	h int
}

fn (p Point) total() int {
	return p.x + p.y
}

fn (b Box) total() int {
	return b.w * b.h
}

// 形参上写着具名类型 —— 这也是 VARTYPE 收的那三处之一
fn boxsum(b Box, k int) int {
	return b.total() + k
}

fn main() {
	p := Point{
		x: 1
		y: 2
	}
	b := Box{
		w: 3
		h: 4
	}
	println(p.total())
	println(b.total())
	println(boxsum(b, 18))
	println(p.total() + 4)
}
