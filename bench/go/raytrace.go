// 真实形状那一档：路径追踪 + 每条扫描线一个 goroutine（照 pt 的 renderer.go：
// `ch := make(chan int, h)` + 每行 `go func(i int)`，主 goroutine 收 h 次）。
//
// 为什么不是 fib/loop 那种：这一档同时压**浮点结构体算术、递归反射、切片访存、
// goroutine 与 channel**四样，而 pt 的热路径就是这四样。确定性用自带的 LCG 保证
// （不用 math/rand），于是答案能与 go 逐字节比。
package main

type Vec struct{ X, Y, Z float64 }

func (a Vec) Add(b Vec) Vec      { return Vec{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a Vec) Sub(b Vec) Vec      { return Vec{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func (a Vec) Mul(b Vec) Vec      { return Vec{a.X * b.X, a.Y * b.Y, a.Z * b.Z} }
func (a Vec) Scale(s float64) Vec { return Vec{a.X * s, a.Y * s, a.Z * s} }
func (a Vec) Dot(b Vec) float64  { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }
func (a Vec) Len() float64       { return sqrt(a.Dot(a)) }
func (a Vec) Norm() Vec          { return a.Scale(1.0 / a.Len()) }

// 牛顿法开方：不依赖 math，两条腿算的是同一串浮点运算
func sqrt(x float64) float64 {
	if x <= 0.0 {
		return 0.0
	}
	g := x
	for i := 0; i < 24; i++ {
		g = 0.5 * (g + x/g)
	}
	return g
}

type Sphere struct {
	Center   Vec
	Radius   float64
	Color    Vec
	Emission float64
}

// 返回命中距离（没命中回 0）
func (s Sphere) Hit(o Vec, d Vec) float64 {
	to := o.Sub(s.Center)
	b := to.Dot(d)
	c := to.Dot(to) - s.Radius*s.Radius
	disc := b*b - c
	if disc <= 0.0 {
		return 0.0
	}
	r := sqrt(disc)
	t := -b - r
	if t > 0.0001 {
		return t
	}
	t = -b + r
	if t > 0.0001 {
		return t
	}
	return 0.0
}

const nspheres = 9

/* 照 pt：场景是一格**切片**（pt 的 Scene.Shapes 是 []Shape），画布也是一格一维切片
   （pt 的 Buffer.Pixels）。不用定长数组 —— 那不是 pt 的形状。 */
var spheres []Sphere

func setup() {
	spheres = make([]Sphere, nspheres)
	spheres[0] = Sphere{Vec{0.0, -1000.0, 0.0}, 1000.0, Vec{0.7, 0.7, 0.7}, 0.0}
	spheres[1] = Sphere{Vec{-2.0, 1.0, -1.0}, 1.0, Vec{0.9, 0.2, 0.2}, 0.0}
	spheres[2] = Sphere{Vec{0.0, 1.0, -1.0}, 1.0, Vec{0.2, 0.9, 0.2}, 0.0}
	spheres[3] = Sphere{Vec{2.0, 1.0, -1.0}, 1.0, Vec{0.2, 0.2, 0.9}, 0.0}
	spheres[4] = Sphere{Vec{-1.0, 0.5, 1.0}, 0.5, Vec{0.9, 0.9, 0.2}, 0.0}
	spheres[5] = Sphere{Vec{1.0, 0.5, 1.0}, 0.5, Vec{0.2, 0.9, 0.9}, 0.0}
	spheres[6] = Sphere{Vec{0.0, 0.4, 2.0}, 0.4, Vec{0.9, 0.5, 0.2}, 0.0}
	spheres[7] = Sphere{Vec{0.0, 6.0, 0.0}, 2.0, Vec{1.0, 1.0, 1.0}, 12.0}
	spheres[8] = Sphere{Vec{-4.0, 3.0, 3.0}, 1.0, Vec{1.0, 0.9, 0.8}, 6.0}
}

/* 确定性的 LCG（照 Numerical Recipes 那一组常数）。每条扫描线一个种子 ——
   于是并发跑与顺序跑出的是**同一张图**，答案能与 go 逐字节比。 */
type Rng struct{ s uint64 }

func (r *Rng) next() float64 {
	r.s = r.s*6364136223846793005 + 1442695040888963407
	return float64((r.s>>11)&1048575) * 0.00000095367431640625
}

const width = 200
const height = 150
const samples = 64
const maxdepth = 4

// 一条光线的辐射度（递归，与 pt 的 sample 同形）
func radiance(o Vec, d Vec, depth int, rng *Rng) Vec {
	if depth > maxdepth {
		return Vec{0.0, 0.0, 0.0}
	}
	best := 0.0
	which := -1
	for i := 0; i < nspheres; i++ {
		t := spheres[i].Hit(o, d)
		if t > 0.0 {
			if which < 0 || t < best {
				best = t
				which = i
			}
		}
	}
	if which < 0 {
		return Vec{0.05, 0.07, 0.12}
	}
	s := spheres[which]
	p := o.Add(d.Scale(best))
	n := p.Sub(s.Center).Norm()
	if s.Emission > 0.0 {
		return s.Color.Scale(s.Emission)
	}
	// 漫反射：在法向那一侧取一个方向
	u := Vec{rng.next()*2.0 - 1.0, rng.next()*2.0 - 1.0, rng.next()*2.0 - 1.0}
	if u.Dot(n) < 0.0 {
		u = u.Scale(-1.0)
	}
	nd := n.Add(u.Norm()).Norm()
	in := radiance(p.Add(n.Scale(0.0001)), nd, depth+1, rng)
	return s.Color.Mul(in)
}

var rows []Vec

// 一条扫描线（一个 goroutine 干这一行）
func renderRow(y int) {
	rng := Rng{uint64(y)*9781 + 12345}
	for x := 0; x < width; x++ {
		acc := Vec{0.0, 0.0, 0.0}
		for s := 0; s < samples; s++ {
			px := (float64(x)+rng.next())/float64(width)*2.0 - 1.0
			py := 1.0 - (float64(y)+rng.next())/float64(height)*2.0
			o := Vec{0.0, 2.0, 8.0}
			d := Vec{px * 1.3, py + 0.2, -1.0}.Norm()
			acc = acc.Add(radiance(o, d, 0, &rng))
		}
		rows[y*width+x] = acc.Scale(1.0 / float64(samples))
	}
}

/* 通道摆在包级、goroutine 的体是一格**具名函数** —— pt 的 renderer.go 那儿用的是闭包
   （`go func(i int){ … }(i)`），而闭包要捕获 `main` 的局部量，那是另一格账（#78 的后半）。
   这一档先把"每条扫描线一个 goroutine + 一格通道收齐"这件事量出来，形状是一样的。 */
var ch chan int

func renderAndReport(y int) {
	renderRow(y)
	ch <- y
}

func main() {
	setup()
	rows = make([]Vec, width*height)
	/* 照 pt 的 renderer.go：容量 = 行数的 channel，每行一个 goroutine，主 g 收 h 次。 */
	ch = make(chan int, height)
	for y := 0; y < height; y++ {
		go renderAndReport(y)
	}
	for i := 0; i < height; i++ {
		<-ch
	}
	/* 校验和：把整张图折成一个整数 —— 逐字节比答案用 */
	sum := 0.0
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			c := rows[y*width+x]
			sum += c.X + c.Y*2.0 + c.Z*3.0
		}
	}
	println(int(sum * 1000.0))
}
