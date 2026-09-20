// 多值返回里带**记录**（go 的 `return hit, v`）。记录在方言里是一格指针，
// 所以它摆得进多值那格结构体 —— 与 `bindRecord` 把记录当字段存是同一件事。
package main

type P struct{ X, Y float64 }

func mk(x, y float64) (P, bool) {
	if x < 0 {
		return P{0, 0}, false
	}
	return P{x, y}, true
}

func main() {
	p, ok := mk(3, 4)
	if ok {
		println(int(p.X + p.Y))
	}
	q, bad := mk(-1, 9)
	if !bad {
		println(int(q.X + q.Y))
	}
}
