// ext/vlang/examples/assertok.v —— **断言那一格**（V 与 mojo 共一族）
//
// 期望输出：3 / 7。
//
// 这一格是**账上算出来的**：`bench/tograph.js` 量到 V 自己的编译器里 578 份文件第一堵墙
// 就是 `assert`（还没落成图的 1918 份里的 30%）—— 一门语言的一个语句形状挡着三成分母，
// 那就该有一格节点，而不是靠映射糊过去。为什么值一格节点（而不是一格 `prim`）：
// 消息是它自己的一格端口，而且它是**可以整格删掉的** —— 那两件事 prim 都给不了
// （三条理由写在 `src/core/graph/nodes.js` 的 `assert` 那一格上）。
//
// **这一份里的断言都是成立的**：条件成立时 assert 什么都不做，所以判据是"它不搅和别的"。
// 不成立那一路的口径是"把一句话印在 print 那一格上、然后整个程序停下来" ——
// 那一路的判据在 `tests/graph/assertfail.js`（各腿的"停下来"不同形，所以单开一格判据）。

module main

fn twice(n int) int {
	assert n > 0
	return n * 2
}

fn main() {
	x := 3
	assert x == 3
	assert x > 1, 'x 要大于 1'
	println(x)
	assert twice(x) == 6, 'twice 坏了'
	println(7)
}
