// ext/vlang/examples/dict.v —— 与 ext/go/examples/dict.go **同一件事**
//
// 期望输出逐行相同：1 / 3 / 4 / yes。
// V 与 go 的 map 字面量在树上同形（`(lit (map …) …)`），差的只有"在不在"那一句的写法：
// V 写成一格算子 `k in m`、go 写成 comma-ok（`_, ok := m[k]`）——
// **落到的是同一格 `map-has`**。写法归语言、格子归节点，这一对是最干净的例子之一。

fn main() {
	mut m := map[string]int{}
	m["a"] = 1
	m["b"] = 3
	println(m["a"])
	println(m["b"])
	m["c"] = 4
	println(m["c"])
	if "a" in m {
		println("yes")
	}
}
