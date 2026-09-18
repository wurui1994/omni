// ext/vlang/examples/mapiter.v —— 与 go 的 mapiter **同一件事**
//
// 期望输出逐行相同：a / b / c / 3 / 9。
// V 与 go 的区别：一个名字给的是**元素**（列表那一族），两个名字才是"键 + 值" ——
// 但 map 的 for-in 里"一个名字"给的是**键**（V 文档里 `for key in m` 就是这个意思）。
// 这一格两门恰好同形：第一格键、第二格值。

fn main() {
	mut m := map[string]int{}
	m["a"] = 1
	m["b"] = 3
	m["c"] = 5
	for k, _ in m {
		println(k)
	}
	mut n := 0
	for _ in m {
		n = n + 1
	}
	println(n)
	mut sum := 0
	for _, v in m {
		sum = sum + v
	}
	println(sum)
}
