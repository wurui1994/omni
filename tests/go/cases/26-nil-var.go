package main

type N struct {
	V int
}

type Shape interface{ Area() int }

type Sq struct{ S int }

func (s *Sq) Area() int { return s.S * s.S }

// `var` 的零值：引用类型（`*T` / 接口）在 go 里是 nil，`== nil` 要为真
func main() {
	var p *N
	if p == nil {
		println("p nil")
	}
	p = &N{V: 3}
	if p != nil {
		println(p.V)
	}
	var s Shape
	if s == nil {
		println("s nil")
	}
	s = &Sq{S: 5}
	if s != nil {
		println(s.Area())
	}
	// 一格接口的数组：`make` 填的是 nil，写过的那一格不是
	xs := make([]Shape, 2)
	xs[1] = &Sq{S: 2}
	n := 0
	for i := 0; i < len(xs); i++ {
		if xs[i] != nil {
			n = n + xs[i].Area()
		}
	}
	println(n)
}
