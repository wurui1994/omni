//omni:pkgs src/lib/go/sort
// `sort` 那份桩：`Float64s` 与 `go` 的结果逐字节相同（升序）。
package main

import "sort"

func main() {
	xs := []float64{5.5, 1.25, 9, -3, 4, 4, 0, 100, 7, 2, 8, 6, 3, 1, 11, 12, -1, 0.5, 42, -7}
	sort.Float64s(xs)
	println(len(xs))
	println(int(xs[0]))
	println(int(xs[1]))
	println(int(xs[2] * 100))
	println(int(xs[len(xs)-1]))
	ok := true
	for i := 1; i < len(xs); i++ {
		if xs[i-1] > xs[i] {
			ok = false
		}
	}
	if ok {
		println("sorted")
	}
	one := []float64{3}
	sort.Float64s(one)
	println(int(one[0]))
	none := []float64{}
	sort.Float64s(none)
	println(len(none))
}
