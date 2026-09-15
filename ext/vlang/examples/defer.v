// ext/vlang/examples/defer.v —— 与 go / sbcl 那两份 defer 例子**同一件事**
//
// 期望输出逐行相同：in / b / a / out。
// V 的 `defer { … }`、go 的 `defer f()`、CL 的 `unwind-protect` —— **同一格 scope-exit 节点**。

fn demo() {
	defer { println("a") }
	defer { println("b") }
	println("in")
	return
}

fn main() {
	demo()
	println("out")
}
