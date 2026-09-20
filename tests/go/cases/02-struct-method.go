package main

type Vector struct{ X, Y, Z float64 }
type Triangle struct {
	V1, V2, V3 Vector
}

func (t *Triangle) SumX() float64 {
	return t.V1.X + t.V2.X + t.V3.X
}

func main() {
	tr := Triangle{}
	println(int(tr.SumX()))
}
