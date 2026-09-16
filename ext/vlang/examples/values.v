// ext/vlang/examples/values.v —— 与 CL / nim 那两份 values 例子**同一件事**
//
// 期望输出逐行相同：3 / 7。
// V 的多返回值写成 `(int, int)` + `return a, b`，消费侧是 `a, b := two()`：
// 生产侧落一格 `values`、消费侧落一串 `pick` —— 与 go 的多返回、CL 的 `values`、
// nim 的元组是**同一对节点**（`ext/vlang/SPEC.md` §五那句"三种双值形式同一个形状"）。

fn two() (int, int) {
	return 3, 7
}

fn main() {
	a, b := two()
	println(a)
	println(b)
}
