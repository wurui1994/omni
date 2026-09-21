// **把 `nil` 赋给引用型的那一格**（pt 的 `node.Shapes = nil`）。
//
// `x = nil` / `p.f = nil` / `xs[i] = nil` 里那个 null **自己说不出类型**：它不是
// 复合字面量也不是函数调用，没有可推的形状。从前后端对它答 `(int 0)`，于是
// `node.Shapes = nil` 落成 `(fldset (var node) Shapes (int 0))` —— 方言当场报类型不符。
//
// 修法是赋值三处（`set` / `fldset` / `aset`）都先问**目标那一格的声明类型**：
// 变量问 env、字段问宿主的形状、元素问切片的元素类型；是记录或数组就印 `(null rN)`。
//
// 钉住的是三处都能收 nil，而且收完之后 `len` 是 0、`== nil` 为真。
package main

type Shape interface{ Area() int }

type Sq struct{ S int }

func (s *Sq) Area() int { return s.S * s.S }

type Node struct {
	Shapes []Shape
	Left   *Node
	Kids   []*Node
}

func main() {
	// 一、字段：切片那一格与记录那一格
	n := &Node{[]Shape{&Sq{3}}, &Node{nil, nil, nil}, nil}
	println(len(n.Shapes)) // 1
	println(n.Left == nil) // false
	n.Shapes = nil
	n.Left = nil
	println(len(n.Shapes)) // 0
	println(n.Left == nil) // true

	// 二、变量：切片、记录、接口三档
	xs := []Shape{&Sq{2}}
	xs = nil
	println(len(xs)) // 0
	p := &Node{nil, nil, nil}
	p = nil
	println(p == nil) // true
	var s Shape = &Sq{4}
	println(s.Area()) // 16
	s = nil
	println(s == nil) // true

	// 三、元素：记录的数组与接口的数组
	kids := make([]*Node, 2)
	kids[0] = &Node{nil, nil, nil}
	println(kids[0] == nil) // false
	kids[0] = nil
	println(kids[0] == nil) // true
	ss := make([]Shape, 1)
	ss[0] = &Sq{5}
	println(ss[0].Area()) // 25
	ss[0] = nil
	println(ss[0] == nil) // true
}
