// ext/vlang/examples/loopexit.v —— 与 go / lua / nim / mojo 那几份**同一件事**
//
// 期望输出逐行相同：12 / 6 / 8。

fn main() {
	mut s := 0
	mut i := 0
	for {
		i = i + 1
		if i > 5 {
			break
		}
		if i == 3 {
			continue
		}
		s = s + i
	}
	println(s)
	println(i)

	mut t := 0
	for j := 0; j < 5; j++ {
		if j == 2 {
			continue
		}
		t = t + j
	}
	println(t)
}
