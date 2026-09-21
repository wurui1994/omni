// **类型 switch**。钉住的是一格"答案静默地错"：`case *B:` 的那一支从前**永远命中**。
//
// 根因：每支的类型名只认 `tname` / `name` 两种 tag，而 `case *B:` 是 `(ptr (tname B))`
// —— 取不出名字就被过滤掉，于是 `typeNames.length === 0`，条件落成 `lit(true)`。
// 图落得出来、跑得动、数字是错的。pt 的
// `switch shape.(type) { case *Volume, *SDFShape, *SphericalHarmonic: inside = false }`
// 三支全是指针类型，于是 `inside` 永远走错那一边。
//
// 现在每支落 `v != nil && v.__type == "T"`（比字段，不调运行期函数 —— 三条腿都成立）。
// 接口的零值记录带 `__type == ""`，所以 nil 接口哪一支都不命中，与 go 对齐。
package main

type Shape interface{ Area() int }

type Sq struct{ S int }
type Re struct{ W, H int }
type Ci struct{ R int }

func (s *Sq) Area() int { return s.S * s.S }
func (r *Re) Area() int { return r.W * r.H }
func (c *Ci) Area() int { return c.R * 3 }

// 指针类型那一支（从前永远命中的就是它）
func kindOf(s Shape) int {
	switch s.(type) {
	case *Sq:
		return 1
	case *Re:
		return 2
	}
	return 0
}

// 一支收多个类型 + default
func family(s Shape) int {
	switch s.(type) {
	case *Sq, *Ci:
		return 10
	default:
		return 20
	}
}

// `switch v := s.(type)` 那一档：绑出来的名字在体里还能调方法
func doubled(s Shape) int {
	switch v := s.(type) {
	case *Sq:
		return v.Area() * 2
	case *Re:
		return v.Area() * 3
	}
	return -1
}

// `case nil:`：nil 接口要命中它，而**别的支一个都不许命中**
func nilKind(s Shape) int {
	switch s.(type) {
	case nil:
		return 100
	case *Sq:
		return 1
	}
	return 0
}

func main() {
	sq := &Sq{4}
	re := &Re{2, 5}
	ci := &Ci{7}

	println(kindOf(sq))   // 1
	println(kindOf(re))   // 2
	println(kindOf(ci))   // 0 —— 从前这儿是 1（第一支永远命中）
	println(family(sq))   // 10
	println(family(re))   // 20
	println(family(ci))   // 10
	println(doubled(sq))  // 32
	println(doubled(re))  // 30
	println(doubled(ci))  // -1
	println(nilKind(sq))  // 1
	println(nilKind(nil)) // 100

	// 装在切片里过一遍（`[]Shape` 那一档，接口值按值抄）
	all := []Shape{sq, re, ci}
	sum := 0
	for i := 0; i < len(all); i++ {
		sum += kindOf(all[i])*100 + all[i].Area()
	}
	println(sum) // 1*100+16 + 2*100+10 + 0*100+21 = 347
}
