// ext/vlang/examples/slice.v —— 与 go / nim / mojo 那几份 slice **同一件事**
//
// 期望输出逐行相同：20 / 30。V 的 `xs[1..3]` 上界也**不含**。

fn main() {
	xs := [10, 20, 30, 40]
	ys := xs[1..3]
	println(ys[0])
	println(ys[1])
}
