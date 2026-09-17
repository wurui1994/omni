// ext/vlang/examples/forin.v —— **`for … in` 落一格计数循环**（V 独一份的家族）
//
// 期望输出：60 / 80 / 6 / 9。
//
// 落的是现成的 `counted`（一格 region 装着起始的 bind 与一格 loop，步进走 post 端口）——
// **一格新节点都没加**。两条 V 自己的规矩：
//   * **一个名字给的是元素**（`for x in xs` 里 x 是元素），两个名字才是"下标 + 元素" ——
//     这一格与 go **正相反**（`for i := range xs` 里 i 是下标）。写法归语言。
//   * `for i in 0..4` 是**区间**：那一路没有序列，i 直接从 0 走到 4（**上界不含**），
//     终点只算一次。
//
// 末一段是嵌一层：里外的临时量各用自己的号（`__in0` / `__in1`）。

module main

fn main() {
	xs := [10, 20, 30]
	mut sum := 0
	for x in xs {
		sum = sum + x
	}
	println(sum)
	mut w := 0
	for i, x in xs {
		w = w + i * x
	}
	println(w)
	mut t := 0
	for i in 0..4 {
		t = t + i
	}
	println(t)
	mut c := 0
	for _ in xs {
		for _ in xs {
			c = c + 1
		}
	}
	println(c)
}
