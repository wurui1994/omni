// 多返回的类型是**真实的**那一格：`retTypeOf` 跑在形参有类型之前，`return a, b`
// 里两格局部量都被量成 int，于是函数声明成 `m6=(int,int)` 而体里交出来的是
// `m15=(real,real)` —— 方言当场骂"要返回 m6，给的是 m15"（pt 的 `Box.Intersect`）。
// `ctx.rets` 那一趟本来就量得准，只是 `isAggregate` 把多值那格排在外头。
package main

type B struct {
	Lo, Hi float64
}

func (b B) Span(k float64) (float64, float64) {
	lo := b.Lo * k
	hi := b.Hi * k
	if lo > hi {
		lo, hi = hi, lo
	}
	return lo, hi
}

// 三格、混类型也要对
func three(n int) (float64, int, bool) {
	x := float64(n) * 1.5
	return x, n + 1, n > 0
}

func main() {
	b := B{2.5, 7.5}
	lo, hi := b.Span(-2.0)
	println(int(lo * 100.0))
	println(int(hi * 100.0))
	p, q := b.Span(4.0)
	println(int(p * 10.0))
	println(int(q * 10.0))
	f, i, ok := three(3)
	println(int(f * 100.0))
	println(i)
	println(ok)
}
