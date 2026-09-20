// `make([]T, n)` 当**结构体字段的初值**（图上是 `prim fill`）。
// 从前这一格**不报缺口、给错类型**：`typeOf(prim fill)` 走算术那一档答 int，于是
// `t.Nodes` 落成 int，`t.Nodes[0].Axis` 才报"在一格说不清形状的东西上取字段"。
// 连着钉住"数组元素是值语义的结构体、就地改它的字段"（`t.Nodes[0].Axis = 9`）。
package main

type B struct{ X, Y float64 }

type N struct {
	Box  B
	Axis int
}

type T struct {
	Nodes []N
	Tag   int
}

func (t *T) add(a int) int {
	t.Nodes = append(t.Nodes, N{B{1.0, 2.0}, a})
	return len(t.Nodes)
}

func main() {
	t := &T{make([]N, 0), 7}
	println(t.add(3))
	println(t.add(4))
	println(t.Nodes[1].Axis)
	t.Nodes[0].Axis = 9
	println(t.Nodes[0].Axis)
}
