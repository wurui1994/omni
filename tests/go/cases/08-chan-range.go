// 并发那一档的第四格：`v, ok := <-ch` 与 `for v := range ch`（收到关为止）。
//
// 这两格是同一件事：go 规范里 `range ch` 的定义就是
//   `for { v, ok := <-ch; if !ok { break }; … }`
// 而方言那一层一次调用只回**一格**值，所以拆成两句（`omni_go_chan_recv2` 收一格并把 ok
// 记在这条 M 的 TLS 里、`omni_go_chan_ok` 取它）——两句之间没有 park，所以 g 不会换 M。
// 见 src/runtime-sched/omni_go.h 上那段账。
//
// 形状：一条生产者 goroutine 往缓冲 2 的通道上发 5 格再 close，主 g 用 range 收干。
// 答案（1..5 的平方和）与调度次序无关。
package main

var ch chan int

func fill() {
	for i := 1; i <= 5; i++ {
		ch <- i * i
	}
	close(ch)
}

func main() {
	ch = make(chan int, 2)
	go fill()
	s := 0
	for v := range ch {
		s += v
	}
	println(s)
}
