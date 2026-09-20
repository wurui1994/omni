// 并发那一档的第三格：`go f(a, b, c)`（三格实参）、通道上的 `len`、`close(ch)`。
//
// 三处都是这一刀之前静默错或当场炸的：
//   * `go f(a,b,c)` —— 门面从前只到一格实参（实参要在 C 那侧打包，见 omni_go.h）；
//   * `len(ch)` —— 从前落 `prim len`（那是切片的长度），通道上它问的是"环里现在有几个"；
//   * `close(ch)` —— tograph 里压根没有这一支，落成"调一个叫 close 的函数"，
//     方言那侧报「未声明的函数 'close'」。
//
// 每条 goroutine 只写自己那一格，所以答案与并发次序无关，能与 go 逐字节比。
package main

var ch chan int
var out []int

const n = 4

func w(i int, k int, m int) {
	out[i] = i*100 + k*10 + m
	ch <- i
}

func main() {
	ch = make(chan int, n)
	out = make([]int, n)
	for i := 0; i < n; i++ {
		go w(i, i+1, i+2)
	}
	for i := 0; i < n; i++ {
		<-ch
	}
	s := 0
	for i := 0; i < n; i++ {
		s += out[i]
	}
	println(s)
	println(len(ch))
	close(ch)
}
