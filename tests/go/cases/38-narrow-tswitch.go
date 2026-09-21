// **`switch t := s.(type)` 里的收窄**（pt 的 `DefaultSampler.sampleLight`）。
//
// go 在"这一支只有一个类型名"时把 `t` 收窄成那个具体类型，于是 `t.Radius` 取的是**字段**。
// 而按 ADR-0040 接口值是一格**方法闭包的记录** —— 接收者只躺在闭包里，记录上压根没有它，
// 于是从前报"记录 r16 上没有字段 'Radius'（它有的是：__type Compile BoundingBox …）"。
//
// 现在给要收窄的每个具体类型加一格**降回去的方法**（`__as_Sphere() *Sphere`）：自己那一份
// 交回接收者、别人那几份交回空引用。名字与类型对同一个接口的所有实现者逐字相同，所以
// `[]Shape` 还是单态的（那正是不能把接收者直接摆一格字段的原因）。
//
// 钉住四格：收窄之后取字段、收窄之后**改**字段（改的是同一格，接口那边看得见）、
// 收窄之后调方法（要落成 `call Sphere__Area(t)`，不是在接口记录上取字段）、
// 以及"一支收多个类型"与 default 两处**不收窄**（go 里那两处 t 仍是接口）。
package main

type Shape interface {
	Area() int
	Name() string
}

type Sphere struct {
	Radius int
	Center int
}

type Box struct{ W, H int }

type Tri struct{ S int }

func (s *Sphere) Area() int    { return s.Radius * s.Radius }
func (s *Sphere) Name() string { return "sphere" }
func (b *Box) Area() int       { return b.W * b.H }
func (b *Box) Name() string    { return "box" }
func (t *Tri) Area() int       { return t.S }
func (t *Tri) Name() string    { return "tri" }

// 收窄之后取字段 + 调方法；default 那一支里 t 还是接口
func measure(s Shape) int {
	switch t := s.(type) {
	case *Sphere:
		return t.Radius + t.Center + t.Area()
	case *Box:
		return t.W * t.H
	default:
		return t.Area() * 100
	}
}

// 收窄之后**改**字段：改的是同一格（接口那边看得见）
func grow(s Shape) {
	switch t := s.(type) {
	case *Sphere:
		t.Radius = t.Radius * 2
	}
}

// 一支收多个类型：go 里 t 仍是接口，只能调方法
func kind(s Shape) string {
	switch t := s.(type) {
	case *Sphere, *Box:
		return t.Name()
	case nil:
		return "nil"
	default:
		return "other:" + t.Name()
	}
}

func main() {
	sp := &Sphere{3, 10}
	bx := &Box{2, 5}
	tr := &Tri{7}

	println(measure(sp)) // 3+10+9 = 22
	println(measure(bx)) // 10
	println(measure(tr)) // 700

	grow(sp)
	println(sp.Radius)   // 6
	println(measure(sp)) // 6+10+36 = 52

	println(kind(sp)) // sphere
	println(kind(bx)) // box
	println(kind(tr)) // other:tri
	println(kind(nil))

	// 装在切片里过一遍（`[]Shape` 还是单态的 —— 降回去那一格不许把形状撑开）
	all := []Shape{sp, bx, tr}
	sum := 0
	for i := 0; i < len(all); i++ {
		sum += measure(all[i])
	}
	println(sum) // 52 + 10 + 700 = 762
}
