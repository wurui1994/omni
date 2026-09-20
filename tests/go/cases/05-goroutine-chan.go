// 并发那一档（任务 #78）：**匿名函数的 goroutine** —— pt 的 renderer.go 用的就是这个形状
// （`ch := make(chan int, h)` + 每行 `go func(i int){ … }(i)`，主 goroutine 收 h 次）。
//
// 体里只借**包级**的名字（`ch` / `out`）与自己那格形参，所以图那一层的 lambda 提升
// 提得上去（`backend-core.js` 的 `liftFnVals`）—— 借了 `main` 的局部量的那种还是一句墙。
//
// 答案与并发次序无关（每条 goroutine 只写自己那一格），所以能与 go 逐字节比。
package main

var ch chan int
var out []int

const n = 8

func main() {
	ch = make(chan int, n)
	out = make([]int, n)
	for i := 0; i < n; i++ {
		go func(k int) {
			out[k] = k * k
			ch <- k
		}(i)
	}
	for i := 0; i < n; i++ {
		<-ch
	}
	s := 0
	for i := 0; i < n; i++ {
		s += out[i]
	}
	println(s)
	println(len(out))
}
