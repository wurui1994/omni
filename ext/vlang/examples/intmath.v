// ext/vlang/examples/intmath.v —— 与 lua / go 那两份 intmath **同一件事**
//
// 期望输出逐行相同：15 / 120。这个家族是"四条腿都跑得动"的那个子集（设计文档 §9）。

fn sumto(n int) int {
	mut acc := 0
	for i := 1; i <= n; i++ {
		acc = acc + i
	}
	return acc
}

fn fact(n int) int {
	if n == 0 {
		return 1
	}
	return n * fact(n - 1)
}

fn main() {
	println(sumto(5))
	println(fact(5))
}
