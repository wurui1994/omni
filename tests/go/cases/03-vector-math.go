// 记录出现在**表达式位置**上（`return Vec{…}` 与 `a.Add(b)` 当实参）。
// 注意每个 println 只给一格实参：go 的 `println(a, b, c)` 是空格分隔的多实参，
// 而方言的 `print` 只收一格 —— 那是另一笔账（前端要降成拼串），不在这一格的判据里。
package main

type Vec struct{ X, Y, Z float64 }

func (a Vec) Add(b Vec) Vec     { return Vec{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a Vec) Dot(b Vec) float64 { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }

func main() {
	a := Vec{1, 2, 3}
	b := Vec{4, 5, 6}
	c := a.Add(b)
	println(int(c.X))
	println(int(c.Y))
	println(int(c.Z))
	println(int(a.Dot(b)))
	println(int(a.Add(b).Dot(a)))
}
