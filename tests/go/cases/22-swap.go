// **`a, b = b, a` 要先把右边全算出来**（go 的规矩：所有右值先求值，再逐格赋）。
//
// 逐格顺着赋是**静默的错答案**：`x, y = y, x` 落成 `x = y; y = x` 就是 9/9 而不是 9/7。
// 量出来的代价不止一格变量：`bench/go/pt.go` 的 BVH 就地分区用的正是
// `t.Shapes[i], t.Shapes[j] = t.Shapes[j], t.Shapes[i]` —— 分错之后 13 个节点变成 33 个，
// 整张图的校验和跟着错（而且**不报任何错**）。
//
// 只在"左边写的名字出现在右边"时才加临时量，所以 `a, b := 1, 2` 那一族的产物不动。
package main

type P struct {
	X, Y int
}

func main() {
	x := 7
	y := 9
	x, y = y, x
	println(x)
	println(y)

	a := []int{1, 2, 3}
	i := 0
	j := 2
	a[i], a[j] = a[j], a[i]
	println(a[0])
	println(a[2])

	// 字段之间换
	p := P{4, 5}
	p.X, p.Y = p.Y, p.X
	println(p.X)
	println(p.Y)

	// 三格轮转
	u := 1
	v := 2
	w := 3
	u, v, w = w, u, v
	println(u)
	println(v)
	println(w)

	// 右边有算式：也要先全算完
	m := 10
	n := 3
	m, n = m+n, m-n
	println(m)
	println(n)

	// 不打架的那一种照旧（这一格钉住"没退化"）
	s := 0
	t := 0
	s, t = 1, 2
	println(s + t*10)
}
