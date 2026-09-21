// **一格函数的体里用到另一格函数交回来的多值**（pt 的 `Node.Partition` 里
// `l, r := box.Partition(axis, point)`）。
//
// core 那侧的形参 / 返回类型是靠**空跑几趟**收的，而"这个函数交回来的是一格多值"从前只在
// 那几趟**全走完之后**才应到 `fn:` 上。于是 `Node.Partition` 每一趟都把 `l` 当 int，
// `if l` 当场报"条件不是 bool"，整个函数体被弃掉 —— 连它自己的 `ret` 都没记上
// （`ctx.rets`）。下一趟还是同一副样子：不动点永远转不到。最后报出来的是隔着两层的那一句
// `'NewNode' 第 1 格实参在两处的类型不一样（(arr r18) 与 int）`。
//
// 修法：每一趟走完就把 `ctx.rets` 应到 `fn:` 上，并把那张表也算进不动点的判据里。
//
// 钉住的是这条链：`Box.Partition`（两格 bool）→ `Node.Partition`（两格 `[]Shape`）→
// `Node.Split` 里的 `NewNode(l)`。外加接口那道环（`Hit.Shape` 是 `Shape`、
// `Shape.Intersect` 交回 `Hit`）—— 那是 pt 真正的形状。
package main

type Vector struct{ X, Y, Z float64 }
type Ray struct{ Origin, Direction Vector }
type Box struct{ Min, Max Vector }
type Material struct{ Gloss float64 }

type Hit struct {
	Shape Shape
	T     float64
}

type Shape interface {
	Compile()
	BoundingBox() Box
	Intersect(Ray) Hit
	UV(Vector) Vector
	NormalAt(Vector) Vector
	MaterialAt(Vector) Material
}

type Sphere struct {
	Center Vector
	Radius float64
	Mat    Material
}

func (s *Sphere) Compile() {}

func (s *Sphere) BoundingBox() Box {
	r := s.Radius
	return Box{Vector{s.Center.X - r, s.Center.Y - r, s.Center.Z - r},
		Vector{s.Center.X + r, s.Center.Y + r, s.Center.Z + r}}
}

func (s *Sphere) Intersect(r Ray) Hit          { return Hit{s, s.Radius} }
func (s *Sphere) UV(p Vector) Vector           { return p }
func (s *Sphere) NormalAt(p Vector) Vector     { return p }
func (s *Sphere) MaterialAt(p Vector) Material { return s.Mat }

type Axis uint8

const (
	AxisNone Axis = iota
	AxisX
	AxisY
	AxisZ
)

func (b Box) Partition(axis Axis, point float64) (left, right bool) {
	switch axis {
	case AxisX:
		left = b.Min.X <= point
		right = b.Max.X >= point
	case AxisY:
		left = b.Min.Y <= point
		right = b.Max.Y >= point
	case AxisZ:
		left = b.Min.Z <= point
		right = b.Max.Z >= point
	}
	return
}

type Node struct {
	Axis   Axis
	Point  float64
	Shapes []Shape
	Left   *Node
	Right  *Node
}

func NewNode(shapes []Shape) *Node {
	return &Node{AxisNone, 0, shapes, nil, nil}
}

func (node *Node) Partition(size int, axis Axis, point float64) (left, right []Shape) {
	left = make([]Shape, 0, size)
	right = make([]Shape, 0, size)
	for _, shape := range node.Shapes {
		box := shape.BoundingBox()
		l, r := box.Partition(axis, point)
		if l {
			left = append(left, shape)
		}
		if r {
			right = append(right, shape)
		}
	}
	return
}

func (node *Node) Split(depth int) {
	if len(node.Shapes) < 2 {
		return
	}
	l, r := node.Partition(len(node.Shapes), AxisX, 0.5)
	node.Left = NewNode(l)
	node.Right = NewNode(r)
	node.Shapes = nil
}

func main() {
	a := &Sphere{Vector{0, 0, 0}, 1, Material{2}}
	b := &Sphere{Vector{9, 9, 9}, 1, Material{3}}
	n := NewNode([]Shape{a, b})
	n.Split(0)
	println(len(n.Left.Shapes))
	println(len(n.Right.Shapes))
	h := a.Intersect(Ray{Vector{0, 0, 0}, Vector{1, 0, 0}})
	println(h.T == 1)
}
