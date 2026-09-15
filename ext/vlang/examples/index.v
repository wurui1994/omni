// ext/vlang/examples/index.v —— 与 go / lua 那两份 index 例子**同一件事**
//
// 期望输出逐行相同：10 / 30 / 45。

fn main() {
	mut xs := [10, 20, 30]
	println(xs[0])
	println(xs[2])
	xs[1] = 5
	mut s := 0
	for i := 0; i < 3; i++ {
		s = s + xs[i]
	}
	println(s)
}
