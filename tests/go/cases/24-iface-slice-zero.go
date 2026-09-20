package main

type Shape interface {
	Area() int
	Name() string
}

type Sq struct {
	S int
}

func (s *Sq) Area() int    { return s.S * s.S }
func (s *Sq) Name() string { return "sq" }

type Re struct {
	W int
	H int
}

func (r *Re) Area() int    { return r.W * r.H }
func (r *Re) Name() string { return "re" }

func total(xs []Shape) int {
	t := 0
	for i := 0; i < len(xs); i++ {
		x := xs[i]
		t += x.Area()
	}
	return t
}

func main() {
	// make 那一支：`a` 的元素类型只能从 `make([]Shape, n)` 的第一格实参上看出来，
	// 于是 `a[0] = &Sq{…}` 才知道要装箱（ADR-0040）
	a := make([]Shape, 2)
	a[0] = &Sq{S: 2}
	a[1] = &Re{W: 2, H: 5}
	println(total(a))
	x := a[0]
	println(x.Name())
	// 字面量那一支：一上来就是装箱好的。两支算出来的形状**必须是同一格** ——
	// 不然递给同一个 `total` 就报"两处的类型不一样"
	b := []Shape{&Sq{S: 4}, &Re{W: 1, H: 3}}
	println(total(b))
	y := b[1]
	println(y.Name())
}
