// **路径追踪基准**（派生自 github.com/fogleman/pt 的结构与算法）。
//
// 为什么不直接编 pt 整包：pt 的 `math/rand` 播的是 `time.Now().UnixNano()` ——
// **本来就不确定**，"与 go run 逐字节相同"这把尺子在它上面立不起来；而它的输出那一半
// 要 image/png/os/bufio。所以这一份把 pt 的**算法与形状**照搬过来、PRNG 自带一格
// （LCG，两边编同一份源码 ⇒ 逐字节可比），末尾印一个校验和而不是写图。
//
// 这一份要压住的，正是 pt 比 raytrace.go 多出来的那几样：
//   - **接口 + 动态分派**（`Shape` 有三个实现，`Hit` 里有一格接口字段 —— Hit 与 Shape
//     互相引用，那是 ADR-0040 那条路上最深的一格）；
//   - **自引用的记录**（BVH 的 `Node.Left/Right *Node`）；
//   - **goroutine + channel**（每行一个任务，N 个工人抢，做完往回发一格 int）；
//   - `[]Shape` / `[]*Node` / `append` / `copy` / `make` / 多返回 / `math.*`。
package main

import "math"

// ---- 自带的 PRNG（PCG 式 LCG，**全走 int64**）------------------------------
//
// 刻意不用 `uint64`：int64 的乘加在 go 与方言里都是**补码回绕**，逐位相同；
// 右移完再 `& 0x7fffffff` 把符号那一半掩掉，所以负数的算术右移也不影响答案。
type Rand struct {
	S int64
}

func (r *Rand) Next() int64 {
	r.S = r.S*6364136223846793005 + 1442695040888963407
	return (r.S >> 33) & 2147483647
}

// [0,1) 的实数。
func (r *Rand) Float() float64 {
	return float64(r.Next()) / 2147483648.0
}

// ---- 向量 -----------------------------------------------------------------
type Vector struct {
	X, Y, Z float64
}

func (a Vector) Add(b Vector) Vector    { return Vector{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a Vector) Sub(b Vector) Vector    { return Vector{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func (a Vector) Mul(b Vector) Vector    { return Vector{a.X * b.X, a.Y * b.Y, a.Z * b.Z} }
func (a Vector) Scale(s float64) Vector { return Vector{a.X * s, a.Y * s, a.Z * s} }
func (a Vector) Dot(b Vector) float64   { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }
func (a Vector) Length() float64        { return math.Sqrt(a.Dot(a)) }

func (a Vector) Normalize() Vector {
	d := a.Length()
	if d == 0.0 {
		return a
	}
	return a.Scale(1.0 / d)
}

func (a Vector) Min(b Vector) Vector {
	return Vector{math.Min(a.X, b.X), math.Min(a.Y, b.Y), math.Min(a.Z, b.Z)}
}

func (a Vector) Max(b Vector) Vector {
	return Vector{math.Max(a.X, b.X), math.Max(a.Y, b.Y), math.Max(a.Z, b.Z)}
}

// ---- 光线、材质、命中 -----------------------------------------------------
type Ray struct {
	Origin, Direction Vector
}

func (r Ray) At(t float64) Vector { return r.Origin.Add(r.Direction.Scale(t)) }

type Material struct {
	Color     Vector
	Emittance float64
	Gloss     float64 // 0 = 全漫反射，1 = 全镜面
}

// **`Hit` 里有一格接口字段，而 `Shape` 的方法又交出 `Hit`** —— Hit 与 Shape 互相引用。
// 这一格是接口那条路上最深的一处（ADR-0040）。
type Hit struct {
	T     float64
	Shape Shape
}

type Shape interface {
	Intersect(r Ray) float64
	NormalAt(p Vector) Vector
	Mat() Material
	Bounds() Box
}

// ---- 包围盒 ---------------------------------------------------------------
type Box struct {
	Min, Max Vector
}

func (a Box) Extend(b Box) Box { return Box{a.Min.Min(b.Min), a.Max.Max(b.Max)} }

// 两个返回值：进入与离开的 t（`tmin > tmax` 就是没打上）。
func (a Box) Intersect(r Ray) (float64, float64) {
	x1 := (a.Min.X - r.Origin.X) / r.Direction.X
	y1 := (a.Min.Y - r.Origin.Y) / r.Direction.Y
	z1 := (a.Min.Z - r.Origin.Z) / r.Direction.Z
	x2 := (a.Max.X - r.Origin.X) / r.Direction.X
	y2 := (a.Max.Y - r.Origin.Y) / r.Direction.Y
	z2 := (a.Max.Z - r.Origin.Z) / r.Direction.Z
	if x1 > x2 {
		x1, x2 = x2, x1
	}
	if y1 > y2 {
		y1, y2 = y2, y1
	}
	if z1 > z2 {
		z1, z2 = z2, z1
	}
	tmin := math.Max(math.Max(x1, y1), z1)
	tmax := math.Min(math.Min(x2, y2), z2)
	return tmin, tmax
}

// ---- 三种形状 -------------------------------------------------------------
type Sphere struct {
	Center Vector
	Radius float64
	M      Material
}

func (s *Sphere) Mat() Material { return s.M }

func (s *Sphere) Bounds() Box {
	r := Vector{s.Radius, s.Radius, s.Radius}
	return Box{s.Center.Sub(r), s.Center.Add(r)}
}

func (s *Sphere) NormalAt(p Vector) Vector { return p.Sub(s.Center).Normalize() }

func (s *Sphere) Intersect(r Ray) float64 {
	to := r.Origin.Sub(s.Center)
	b := to.Dot(r.Direction)
	c := to.Dot(to) - s.Radius*s.Radius
	d := b*b - c
	if d <= 0.0 {
		return 0.0
	}
	d = math.Sqrt(d)
	t1 := -b - d
	if t1 > 0.0001 {
		return t1
	}
	t2 := -b + d
	if t2 > 0.0001 {
		return t2
	}
	return 0.0
}

type Plane struct {
	Point, Normal Vector
	M             Material
}

func (p *Plane) Mat() Material            { return p.M }
func (p *Plane) NormalAt(q Vector) Vector { return p.Normal }

func (p *Plane) Bounds() Box {
	big := 1000000.0
	return Box{Vector{-big, -big, -big}, Vector{big, big, big}}
}

func (p *Plane) Intersect(r Ray) float64 {
	d := p.Normal.Dot(r.Direction)
	if d > -0.0001 && d < 0.0001 {
		return 0.0
	}
	t := p.Point.Sub(r.Origin).Dot(p.Normal) / d
	if t < 0.0001 {
		return 0.0
	}
	return t
}

type Cube struct {
	Min, Max Vector
	M        Material
}

func (c *Cube) Mat() Material { return c.M }
func (c *Cube) Bounds() Box   { return Box{c.Min, c.Max} }

func (c *Cube) NormalAt(p Vector) Vector {
	e := 0.0001
	if p.X < c.Min.X+e {
		return Vector{-1.0, 0.0, 0.0}
	}
	if p.X > c.Max.X-e {
		return Vector{1.0, 0.0, 0.0}
	}
	if p.Y < c.Min.Y+e {
		return Vector{0.0, -1.0, 0.0}
	}
	if p.Y > c.Max.Y-e {
		return Vector{0.0, 1.0, 0.0}
	}
	if p.Z < c.Min.Z+e {
		return Vector{0.0, 0.0, -1.0}
	}
	return Vector{0.0, 0.0, 1.0}
}

func (c *Cube) Intersect(r Ray) float64 {
	tmin, tmax := Box{c.Min, c.Max}.Intersect(r)
	if tmin > tmax || tmax < 0.0001 {
		return 0.0
	}
	if tmin > 0.0001 {
		return tmin
	}
	return tmax
}

// ---- BVH（**扁平**：节点摆在一格数组里，孩子用下标）------------------------
//
// 刻意不用 `Left/Right *Node`：自引用的**结构体字段**在这条腿上还欠一格
// （字段的零值是 nil，于是那个字段落成 int —— 任务 #84 的 `__zeroof_T`）。
// 扁平表示本来也是更快的那一种，而且它压的是另外两样：`[]Node`（值语义结构体的数组）
// 与 `[]Shape`（接口的数组）。
type Node struct {
	Box    Box
	Axis   int // -1 = 叶子
	Lo, Hi int // 叶子：Shapes[Lo:Hi]
	L, R   int // 内部：Nodes 的下标
}

type Tree struct {
	Nodes  []Node
	Shapes []Shape
}

func boxOf(shapes []Shape, lo int, hi int) Box {
	b := shapes[lo].Bounds()
	for i := lo; i < hi; i++ {
		b = b.Extend(shapes[i].Bounds())
	}
	return b
}

func axisOf(v Vector, axis int) float64 {
	if axis == 0 {
		return v.X
	}
	if axis == 1 {
		return v.Y
	}
	return v.Z
}

// 照 pt 的做法：按最长轴的中点切。就地按中点分区（不用 sort）。
func (t *Tree) build(lo int, hi int, depth int) int {
	box := boxOf(t.Shapes, lo, hi)
	me := len(t.Nodes)
	t.Nodes = append(t.Nodes, Node{box, -1, lo, hi, 0, 0})
	if hi-lo <= 2 || depth > 12 {
		return me
	}
	size := box.Max.Sub(box.Min)
	axis := 0
	best := size.X
	if size.Y > best {
		axis = 1
		best = size.Y
	}
	if size.Z > best {
		axis = 2
	}
	mid := (axisOf(box.Min, axis) + axisOf(box.Max, axis)) * 0.5
	// 就地分区：中心在 mid 之前的挪到左边
	i := lo
	for j := lo; j < hi; j++ {
		b := t.Shapes[j].Bounds()
		c := (axisOf(b.Min, axis) + axisOf(b.Max, axis)) * 0.5
		if c < mid {
			t.Shapes[i], t.Shapes[j] = t.Shapes[j], t.Shapes[i]
			i++
		}
	}
	if i == lo || i == hi {
		return me
	}
	l := t.build(lo, i, depth+1)
	r := t.build(i, hi, depth+1)
	t.Nodes[me].Axis = axis
	t.Nodes[me].L = l
	t.Nodes[me].R = r
	return me
}

func newTree(shapes []Shape) *Tree {
	t := &Tree{make([]Node, 0), shapes}
	t.build(0, len(shapes), 0)
	return t
}

func (t *Tree) search(at int, r Ray) Hit {
	h := Hit{0.0, nil}
	n := t.Nodes[at]
	tmin, tmax := n.Box.Intersect(r)
	if tmin > tmax || tmax < 0.0001 {
		return h
	}
	if n.Axis < 0 {
		best := 0.0
		for i := n.Lo; i < n.Hi; i++ {
			s := t.Shapes[i]
			tt := s.Intersect(r)
			if tt > 0.0001 && (best == 0.0 || tt < best) {
				best = tt
				h.T = tt
				h.Shape = s
			}
		}
		return h
	}
	a := t.search(n.L, r)
	b := t.search(n.R, r)
	if a.T == 0.0 {
		return b
	}
	if b.T == 0.0 {
		return a
	}
	if a.T < b.T {
		return a
	}
	return b
}

// ---- 采样（蒙特卡洛，深度有限）--------------------------------------------
func cosineDir(n Vector, rnd *Rand) Vector {
	// 在半球上按余弦分布取一个方向：先在单位球里取点，再往法向那一侧折。
	for i := 0; i < 16; i++ {
		x := rnd.Float()*2.0 - 1.0
		y := rnd.Float()*2.0 - 1.0
		z := rnd.Float()*2.0 - 1.0
		v := Vector{x, y, z}
		if v.Dot(v) > 1.0 {
			continue
		}
		v = v.Normalize()
		if v.Dot(n) < 0.0 {
			v = v.Scale(-1.0)
		}
		return v
	}
	return n
}

func reflect(d Vector, n Vector) Vector { return d.Sub(n.Scale(2.0 * d.Dot(n))) }

func sample(root *Tree, r Ray, depth int, rnd *Rand) Vector {
	if depth <= 0 {
		return Vector{0.0, 0.0, 0.0}
	}
	h := root.search(0, r)
	if h.T == 0.0 {
		// 天光：往上看越亮
		t := 0.5 * (r.Direction.Normalize().Y + 1.0)
		return Vector{0.4 + 0.3*t, 0.5 + 0.3*t, 0.7 + 0.3*t}
	}
	m := h.Shape.Mat()
	p := r.At(h.T)
	n := h.Shape.NormalAt(p)
	if m.Emittance > 0.0 {
		return m.Color.Scale(m.Emittance)
	}
	var dir Vector
	if rnd.Float() < m.Gloss {
		dir = reflect(r.Direction.Normalize(), n)
	} else {
		dir = cosineDir(n, rnd)
	}
	next := Ray{p.Add(n.Scale(0.0001)), dir}
	in := sample(root, next, depth-1, rnd)
	return m.Color.Mul(in)
}

// ---- 场景 + 渲染（goroutine + channel）------------------------------------
func scene() []Shape {
	shapes := []Shape{}
	mats := []Material{
		{Vector{0.9, 0.3, 0.3}, 0.0, 0.0},
		{Vector{0.3, 0.9, 0.4}, 0.0, 0.2},
		{Vector{0.4, 0.5, 0.95}, 0.0, 0.6},
		{Vector{1.0, 0.95, 0.8}, 6.0, 0.0},
	}
	shapes = append(shapes, &Plane{Vector{0.0, -1.0, 0.0}, Vector{0.0, 1.0, 0.0},
		Material{Vector{0.8, 0.8, 0.8}, 0.0, 0.0}})
	// 5×5 的小球阵 + 几个立方体：够 BVH 真的分叉
	k := 0
	for i := 0; i < 5; i++ {
		for j := 0; j < 5; j++ {
			x := float64(i)*1.1 - 2.2
			z := float64(j)*1.1 - 2.2
			shapes = append(shapes, &Sphere{Vector{x, -0.6, z}, 0.4, mats[k%4]})
			k++
		}
	}
	for i := 0; i < 3; i++ {
		x := float64(i)*2.0 - 2.0
		shapes = append(shapes, &Cube{Vector{x - 0.3, -1.0, 1.6}, Vector{x + 0.3, -0.4, 2.2},
			mats[(i+1)%4]})
	}
	shapes = append(shapes, &Sphere{Vector{0.0, 3.0, 0.0}, 1.0, mats[3]})
	return shapes
}

// **共享的那几格摆在包一级**：`go f(i)` 的门面只到 3 格实参，而工人要看见的东西不止三样
// （pt 的 renderer 是靠接收者带过去的，这儿靠包级变量 —— 同一件事）。
var gRoot *Tree
var gBuf []float64
var gW int
var gH int
var gSPP int
var gN int
var gCh chan int

// 针孔相机：把 [0,1)² 映到一条从 eye 出发的光线。
func camRay(u float64, v float64) Ray {
	eye := Vector{0.0, 1.2, 6.0}
	x := (u - 0.5) * 4.0
	y := (0.5 - v) * 3.0
	dir := Vector{x, y, -5.0}.Normalize()
	return Ray{eye, dir}
}

// 每个工人做**自己那几行**（`y = id; y += gN`），所以答案与调度次序无关。
func worker(id int) {
	rnd := &Rand{int64(id)*2654435761 + 12345}
	for y := id; y < gH; y += gN {
		for x := 0; x < gW; x++ {
			c := Vector{0.0, 0.0, 0.0}
			for s := 0; s < gSPP; s++ {
				u := (float64(x) + rnd.Float()) / float64(gW)
				v := (float64(y) + rnd.Float()) / float64(gH)
				c = c.Add(sample(gRoot, camRay(u, v), 4, rnd))
			}
			c = c.Scale(1.0 / float64(gSPP))
			o := (y*gW + x) * 3
			gBuf[o] = c.X
			gBuf[o+1] = c.Y
			gBuf[o+2] = c.Z
		}
	}
	gCh <- id
}

func main() {
	gW = 96
	gH = 72
	gSPP = 12
	gN = 4
	gRoot = newTree(scene())
	gBuf = make([]float64, gW*gH*3)
	gCh = make(chan int, gN)
	for i := 0; i < gN; i++ {
		go worker(i)
	}
	for i := 0; i < gN; i++ {
		<-gCh
	}
	// 校验和：每格量化成 0..255 再按位置加权 —— 一格像素错了这个数就变。
	sum := 0
	for i := 0; i < gW*gH*3; i++ {
		q := int(math.Floor(gBuf[i]*255.0 + 0.5))
		if q < 0 {
			q = 0
		}
		if q > 255 {
			q = 255
		}
		sum = (sum*131 + q) & 1073741823
	}
	println(sum)
}
