// **接口与结构体互相引用**（pt 的 `Shape.Intersect(Ray) Hit` 配 `Hit.Shape Shape`）。
//
// 钉住的是三格：
//  1. 环上那两格记录的零值算得出来。从前 `structZero` 的环闸回 null，于是 `Hit.Shape`
//     落成 int，`shape := hit.Shape` 报"在一格说不清形状的东西上取字段 'Area'"。
//  2. 环解开之后**两格的标签各归各主**。从前自引用只有一个占位串，于是里层那一格被换成
//     外层的标签 —— 量出来是 `(struct r1 (Shape r1) (T int))`：Hit 的 Shape 落成了 Hit。
//  3. 同一对环**从哪一格进去都只有一份形状**。占位串按"字段名单"起名（不按次序编号），
//     所以带占位串的那把键处处相同；不然从 Hit 进与从 Shape 进各出一对，随后
//     `要返回 r5，给的是 r8`。
package main

type Shape interface {
	Area() int
	Intersect(r int) Hit
}

type Hit struct {
	Shape Shape
	T     int
}

type Sq struct{ S int }
type Re struct{ W, H int }

func (s *Sq) Area() int           { return s.S * s.S }
func (s *Sq) Intersect(r int) Hit { return Hit{s, r + s.S} }

func (e *Re) Area() int           { return e.W * e.H }
func (e *Re) Intersect(r int) Hit { return Hit{e, r * e.W} }

// 没命中那一格：`Hit{nil, 999}` 的 Shape 字段是真 nil
var NoHit = Hit{nil, 999}

// 接口进、接口出（`hit.Shape` 再交出去）
func nearest(a, b Hit) Hit {
	if a.T < b.T {
		return a
	}
	return b
}

func main() {
	sq := &Sq{5}
	re := &Re{2, 7}

	h1 := sq.Intersect(2)
	h2 := re.Intersect(3)

	shape := h1.Shape
	println(shape.Area()) // 25
	println(h1.T)         // 7
	println(h2.T)         // 6

	best := nearest(h1, h2)
	println(best.T)            // 6
	println(best.Shape.Area()) // 14

	// nil 那一格：`Hit{nil, 999}` 的 Shape 真的是 nil
	println(NoHit.T)              // 999
	println(NoHit.Shape == nil)   // true
	println(nearest(h1, NoHit).T) // 7

	// 装在切片里过一遍（`[]Hit` 那一档）
	hits := []Hit{h1, h2, NoHit}
	sum := 0
	for i := 0; i < len(hits); i++ {
		if hits[i].Shape != nil {
			sum += hits[i].Shape.Area() + hits[i].T
		}
	}
	println(sum) // 25+7 + 14+6 = 52
}
