package main

type Vec struct{ X, Y, Z float64 }

func (a Vec) Add(b Vec) Vec  { return Vec{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a Vec) Mul(b Vec) Vec  { return Vec{a.X * b.X, a.Y * b.Y, a.Z * b.Z} }
func (a Vec) Scale(s float64) Vec { return Vec{a.X * s, a.Y * s, a.Z * s} }
func (a Vec) Dot(b Vec) float64   { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }

func main() {
	acc := Vec{0, 0, 0}
	for i := 0; i < 60000000; i++ {
		f := float64(i&255) * 0.00390625
		a := Vec{f, f + 1, f + 2}
		b := Vec{f + 3, f + 4, f + 5}
		acc = acc.Add(a.Add(b).Mul(a).Scale(0.5))
	}
	println(int(acc.Dot(Vec{1, 1, 1})))
}
