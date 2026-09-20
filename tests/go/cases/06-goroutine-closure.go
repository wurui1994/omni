// 并发那一档的第二格：通道与画布都是 **`main` 的局部量**，goroutine 的体**借**它们
// —— pt 的 renderer.go 一字不差就是这个形状（`ch := make(chan int, h)` 在 `Render` 里，
// `go func(i int){ … }(i)` 借着它）。
//
// 落法：`liftFnVals` 把那格匿名函数提成方言的**闭包**（`(cfn 名 (借来的…) (形参…) …)`），
// 用处那一格是 `(mkclo 名 值…)`，体里读借来的东西是 `(cap 名)`。借的那几格**按值抄一份**
// —— 切片与通道在方言里都是一个句柄，所以"里头改了外头看得见"仍旧成立。
//
// 答案与并发次序无关（每条 goroutine 只写自己那一格），所以能与 go 逐字节比。
package main

const n = 8

func main() {
	ch := make(chan int, n)
	out := make([]int, n)
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
}
