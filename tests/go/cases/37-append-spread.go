// `s = append(s, xs...)`（摊开那一档）。从前它落 `call __goAppend` —— 那个函数的体只在
// **js 那条腿的运行时**里，core 上压根没有（pt 整包就报"调一格这一层里没有的函数
// '__goAppend'"）。现在落成一趟数着的循环 + 一串 push。
//
// 顺带钉住 `a = append(a, a...)`：go 的语义是"把**原来**那些接上去"，所以长度得先取一份 ——
// 条件里每趟重算 `len(a)` 的话它会一直长下去（那是一次挂起，不是错答案）。
package main

type Tri struct{ A, B int }

func polys(n int) []Tri {
	out := []Tri{}
	for i := 0; i < n; i++ {
		out = append(out, Tri{i, i * 2})
	}
	return out
}

type Mesh struct {
	Triangles []Tri
}

// 字段当左值那一档（`a.Triangles = append(a.Triangles, b.Triangles...)`，pt 里就有）
func (a *Mesh) Add(b *Mesh) {
	a.Triangles = append(a.Triangles, b.Triangles...)
}

func main() {
	all := []Tri{}
	for k := 1; k <= 3; k++ {
		all = append(all, polys(k)...)
	}
	println(len(all)) // 6
	sum := 0
	for i := 0; i < len(all); i++ {
		sum += all[i].A + all[i].B
	}
	println(sum) // 9

	// 自己摊给自己
	xs := []int{1, 2, 3}
	xs = append(xs, xs...)
	println(len(xs)) // 6
	t := 0
	for i := 0; i < len(xs); i++ {
		t += xs[i]
	}
	println(t) // 12

	// 空的那一格摊开（一趟都不跑）
	ys := []int{9}
	ys = append(ys, []int{}...)
	println(len(ys)) // 1

	m1 := &Mesh{[]Tri{{1, 2}}}
	m2 := &Mesh{[]Tri{{3, 4}, {5, 6}}}
	m1.Add(m2)
	tris := m1.Triangles
	println(len(tris)) // 3
	ts := 0
	for i := 0; i < len(tris); i++ {
		ts += tris[i].A + tris[i].B
	}
	println(ts) // 3+7+11 = 21

	// **字段的初值是一次调用、而它交出来的是一格切片**（`&Mesh{polys(2)}`）：
	// 从前报"字段 / 下标的宿主不是一个名字" —— 那一格句柄要先物化成一格临时名。
	m3 := &Mesh{polys(4)}
	m3.Add(m1)
	println(len(m3.Triangles)) // 4+3 = 7
	println(m3.Triangles[3].B) // 6
}
