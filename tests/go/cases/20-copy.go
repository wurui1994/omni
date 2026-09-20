package main

// `copy(dst, src)` 落成一圈逐格写（不是调运行时的 `__goCopy` —— 那个只在 js 腿有体）。
// 钉三件事：拷的格数是两边长度的小的那个、两边各只求一次值、元素是记录时整格写。

type P struct {
	X, Y int
}

func mk(n int) []int {
	s := make([]int, n)
	for i := 0; i < n; i++ {
		s[i] = i + 1
	}
	return s
}

func main() {
	src := mk(5)
	dst := make([]int, 3)
	copy(dst, src)
	println(dst[0] + dst[1]*10 + dst[2]*100)
	big := make([]int, 7)
	copy(big, src)
	println(big[4])
	println(big[5])
	ps := []P{{1, 2}, {3, 4}}
	qs := make([]P, 2)
	copy(qs, ps)
	println(qs[1].X + qs[1].Y)
}
