// **变参**（pt 的 `func NewUnionSDF(items ...SDF) SDF`）。
//
// 两处从前都错：
//  1. 函数体里那格变参的**声明类型是 `[]T`**，语法树上摆的却是元素类型 `T` —— 于是
//     `&UnionSDF{items}` 里 `Items` 那一格算出两格形状（`(arr r2)` 与 `r2`），core 报
//     `'__box_UnionSDF__SDF' 第 1 格形参落成了 r4{Items: (arr r2)}，…给的是 r5{Items: r2}`；
//  2. 调用点**没打包**：方言的函数是定元数的，图上也没有"剩下的实参"这一格。现在
//     `f(a, b)` 落成 `f([]T{a, b})`（`packVariadic`），`restParam`（js 的 `...name`）不发了 ——
//     所有后端看到的都是一格普通的数组形参。变参那几格还要**共用同一个声明类型**去装箱，
//     不然打出来的列表里元素类型不一样。
//
// 钉住的几格：零格实参、几格实参、`f(xs...)`（原样递那一格切片）、变参的**方法**、
// 元素是接口时逐格装箱、以及体里的 `len` / `range` / 取下标。
package main

type SDF interface {
	Eval(p int) int
}

type Sph struct{ R int }

func (s *Sph) Eval(p int) int { return p - s.R }

type Uni struct {
	Items []SDF
}

func NewUni(items ...SDF) *Uni { return &Uni{items} }

func (u *Uni) Eval(p int) int {
	best := 0
	for i, it := range u.Items {
		d := it.Eval(p)
		if i == 0 || d < best {
			best = d
		}
	}
	return best
}

func (u *Uni) Count() int { return len(u.Items) }

func sum(base int, ns ...int) int {
	t := base
	for i := 0; i < len(ns); i++ {
		t += ns[i]
	}
	return t
}

func (s *Sph) Grow(steps ...int) int {
	for _, k := range steps {
		s.R += k
	}
	return s.R
}

func main() {
	println(sum(1))       // 1（零格变参）
	println(sum(1, 2, 3)) // 6
	ns := []int{4, 5}
	println(sum(10, ns...)) // 19（spread：原样递那一格切片）

	a := &Sph{2}
	b := &Sph{9}
	u := NewUni(a, b)
	println(u.Count())        // 2
	println(u.Eval(10))       // 1
	println(NewUni().Count()) // 0

	println(a.Grow())     // 2（变参的方法，零格）
	println(a.Grow(3, 4)) // 9
}
