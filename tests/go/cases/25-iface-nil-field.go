package main

type Shape interface {
	Area() int
}

type Sq struct{ S int }

func (s *Sq) Area() int { return s.S * s.S }

// 接口当字段：写着 nil 的那一格要真是 nil（ADR-0040 + `record-new` 的 fzero）
type Hit struct {
	T     int
	Shape Shape
}

func report(h Hit) int {
	if h.Shape != nil {
		return h.T + h.Shape.Area()
	}
	return h.T
}

func main() {
	// 位置式字面量里写 nil
	miss := Hit{5, nil}
	println(report(miss))
	// 带字段名的字面量里写 nil
	miss2 := Hit{T: 7, Shape: nil}
	println(report(miss2))
	// 真装了一格进去
	hit := Hit{2, &Sq{S: 3}}
	println(report(hit))
	// `var` 的零值：接口那一格也是 nil
	var z Hit
	println(report(z))
	if z.Shape == nil {
		println("zero is nil")
	}
	// 赋进去之后就不是 nil 了
	z.Shape = &Sq{S: 4}
	z.T = 1
	println(report(z))
}
