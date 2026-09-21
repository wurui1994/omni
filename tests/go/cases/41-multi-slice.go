// **多值里带切片**（pt 的 `Node.Partition(size, axis, point) (left, right []Shape)`）。
//
// 方言的多值是一格**值语义的合成结构体**，而切片与字典在方言里是**句柄**（一格字）——
// 摆进那格结构体里与记录（一格指针）同理。从前 `multiShape` 只收标量与记录，
// 于是 `return left, right` 报"多值里有一格不是标量也不是记录（量到的是 (arr r18)）"。
//
// 钉住的是**句柄语义**：从返回的那两格里改元素，原来那一格跟着变（go 的切片返回的是
// 同一块底层数组）。
package main

type Shape interface{ Area() int }

type Sq struct{ S int }

func (s *Sq) Area() int { return s.S * s.S }

// 两格切片 + 一格整数（不用 `xs[:at]` —— 切片表达式在 core 那腿上是另一格缺口）
func split(xs []Shape, at int) (left, right []Shape, n int) {
	left = []Shape{}
	right = []Shape{}
	for i := 0; i < len(xs); i++ {
		if i < at {
			left = append(left, xs[i])
		} else {
			right = append(right, xs[i])
		}
	}
	n = len(xs)
	return
}

// 两格切片（**字典那一档不收** —— 方言的结构体字段不收 `(dict K V)`，见 `multiShape`）
func both(xs []int) ([]int, []int) {
	ys := []int{}
	for i := 0; i < len(xs); i++ {
		ys = append(ys, xs[i]*2)
	}
	return xs, ys
}

func main() {
	all := []Shape{&Sq{2}, &Sq{3}, &Sq{4}, &Sq{5}}
	l, r, n := split(all, 2)
	println(n)           // 4
	println(len(l))      // 2
	println(len(r))      // 2
	println(l[0].Area()) // 4
	println(r[0].Area()) // 16

	ns := []int{7, 8}
	s, d := both(ns)
	println(len(s)) // 2
	println(d[0])   // 14
	println(d[1])   // 16
	// 句柄语义：`both` 交回来的第一格就是同一格切片，改它原来那格跟着变
	s[0] = 70
	println(ns[0]) // 70
}
