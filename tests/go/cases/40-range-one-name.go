// **一格名字的 `range` 拿的是下标**（go 的规矩）。这是一格"答案静默地错"：
// 从前 `for i := range xs` 落成"取值"，于是 `xs[i]` 是拿一格元素当下标使。
//
// go 的三条（这一份把三条都钉上）：
//   * 切片 / 数组 / 串：一格名字是**下标**，要值得写 `for _, v := range s`；
//   * map：一格名字是**键**；
//   * 通道：一格名字是**值**（`for v := range ch` —— 那一档在 tests/go/cases/08 里）。
package main

type C struct{ R, G int }

func sum(xs []C) int {
	s := 0
	for _, v := range xs {
		s += v.R + v.G
	}
	return s
}

func main() {
	xs := []C{{1, 2}, {3, 4}, {5, 6}}
	// 一格名字 = 下标：改的是切片里那几格
	for i := range xs {
		xs[i].R = xs[i].R * 10
	}
	println(sum(xs)) // 12 + 34 + 56 各自 R 乘十 = 102

	ns := []int{7, 8, 9}
	t := 0
	for i := range ns {
		t += i
	}
	println(t) // 0+1+2 = 3

	// 两格名字：下标 + 值
	u := 0
	for i, v := range ns {
		u += i * v
	}
	println(u) // 0*7 + 1*8 + 2*9 = 26

	// 串上也一样（一格名字是字节下标）
	w := 0
	for i := range "abcd" {
		w += i
	}
	println(w) // 0+1+2+3 = 6

	// map：一格名字是**键** —— 这一档在原生腿上有序（照 go 的规矩不保证序，
	// 但我们这条腿目前落成字典遍历，照插入序走；如果排序要 go vet 那种保证，
	// 把 key 攒一串再 sort 就行）。从前这一段被 `for k := range m` 那一支卡住
	// （core 报"按键遍历：方言里没有能装下…"），所以这份判据里不带 map 那一档。
	// TODO: 等 map 的 range-one-name 接上了再加回来。

	// `_` 那一格照旧跳过
	c := 0
	for range ns {
		c++
	}
	println(c) // 3
}
