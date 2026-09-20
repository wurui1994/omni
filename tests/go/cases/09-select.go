// 并发那一档的第五格：`select`（收、发、default 三种 case 都在）。
//
// 落法照 go 规范里它的语义摊成三段（`omni_go_sel_*`，见 src/runtime-sched/omni_go.h）：
// 先把每一格 case 报上去、再 `__goSelGo()` 真选、再按下标落一条 if 链。
// 从前 tograph 里这一格是"取第一个 case 的体、无条件跑" —— 编得出来、跑得动、答案静默地错。
//
// 形状：两条生产者各发 3 格，主 g 用 select 收 6 次（哪一路先到都行 —— 和是定的）；
// 再验 default（两条通道都空了）与"发"那一路（往缓冲 1 的通道上发得进去）。
package main

var a chan int
var b chan int

func fa() {
	for i := 0; i < 3; i++ {
		a <- 10 + i
	}
}

func fb() {
	for i := 0; i < 3; i++ {
		b <- 100 + i
	}
}

func main() {
	a = make(chan int, 1)
	b = make(chan int, 1)
	go fa()
	go fb()
	s := 0
	for i := 0; i < 6; i++ {
		select {
		case v := <-a:
			s += v
		case w := <-b:
			s += w
		}
	}
	println(s)

	// default 那一路：两条通道都空了，收不到就走 default
	got := 0
	select {
	case <-a:
		got = 1
	default:
		got = 2
	}
	println(got)

	// 发那一路：缓冲还空着，所以这一格选得中
	which := 0
	select {
	case a <- 7:
		which = 1
	default:
		which = 2
	}
	println(which)
	println(<-a)
}
