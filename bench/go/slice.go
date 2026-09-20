// 访存密集：切片上的顺序与跳步读写
package main

func main() {
	n := 4000000
	xs := make([]float64, n)
	for i := 0; i < n; i++ {
		xs[i] = float64(i&1023) * 0.5
	}
	s := 0.0
	for r := 0; r < 8; r++ {
		for i := 0; i < n; i++ {
			s += xs[i]
		}
	}
	println(int(s))
}
