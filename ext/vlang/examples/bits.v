// ext/vlang/examples/bits.v —— **位运算那六格内建**（与 go 那一份同一族）
//
// 期望输出：8 / 14 / 6 / 6 / -13。
//
// V 与 go 差两处写法，都归这门语言的映射：
//   * 按位取反是 `~x`（go 写 `^x`）；
//   * **`<<` 不是位移**：在 V 里它压倒性地是列表追加（`push` 那一族判着），所以这一份
//     里没有 `<<` —— 位移只用 `>>`。
// `^` 两门都是 xor，都映到内建 `bxor`（图上的 `^` 是幂，撞名那笔账写在 go 那一份里）。

module main

fn main() {
	a := 12
	b := 10
	println(a & b)
	println(a | b)
	println(a ^ b)
	println(48 >> 3)
	println(~a)
}
