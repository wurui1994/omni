package main

type Vec struct{ X, Y, Z float64 }

func (a Vec) Add(b Vec) Vec { return Vec{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a Vec) Dot(b Vec) float64 { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }

func main() {
	a := Vec{1, 2, 3}
	b := Vec{4, 5, 6}
	c := a.Add(b)
	println(int(c.X), int(c.Y), int(c.Z))
	println(int(a.Dot(b)))
}
