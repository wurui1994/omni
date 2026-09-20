package main

import "fmt"

type Shape interface {
	Area() float64
	Name() string
}

type Sq struct {
	side float64
}

type Ci struct {
	r float64
}

type Rect struct {
	w, h float64
}

func (s Sq) Area() float64    { return s.side * s.side }
func (s Sq) Name() string     { return "sq" }
func (c Ci) Area() float64    { return 3.0 * c.r * c.r }
func (c Ci) Name() string     { return "ci" }
func (r *Rect) Area() float64 { return r.w * r.h }
func (r *Rect) Name() string  { return "rect" }

func describe(s Shape) {
	fmt.Println(s.Name())
	fmt.Println(s.Area())
}

func total(xs []Shape) float64 {
	t := 0.0
	for i := 0; i < len(xs); i++ {
		t += xs[i].Area()
	}
	return t
}

func main() {
	xs := []Shape{Sq{2}, Ci{1}, &Rect{3, 4}}
	for i := 0; i < len(xs); i++ {
		describe(xs[i])
	}
	fmt.Println(total(xs))

	var one Shape = Sq{5}
	describe(one)
	one = &Rect{2, 2}
	describe(one)
}
