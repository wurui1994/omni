// ext/vlang/examples/hoist.v —— **表达式位置上的临时量（"物化"）**（V 独一份）
//
// 期望输出：12 / 14 / 108。
//
// `or-block` / `f()!` 落出来的是**一串语句**（绑一格 + 一格 branch），塞不进表达式位置 ——
// 从前 `g(f() or { 0 })` 那一族当场报。这一格把那一串**提到当前语句前面**，表达式位置上
// 只留一格 `ref`：图上一格新节点也没加。
//
// **提升会改求值次序，所以有一条判据**（`safeToHoist`）：按求值次序走一遍当前语句，
// 走到这一格之前**不许遇到**带副作用的东西（调用 / 赋值 / 自增 / 另一格 or-block / match）。
// 两处细节都是量出来的：
//   * **包着它的那格调用不算"先发生"** —— 一格调用的实参先算、它自己后发生，所以
//     `println(twice(find(3) or { 0 }))` 提得动（头一版把外层的 `println` 也算成了"先"，
//     于是这一族一份都提不动）；
//   * `add(noisy(), find(3) or { 0 })` **提不动**：`noisy()` 在它前面，提上去就把
//     两处副作用的次序换了 —— 那一份照旧当场报，留在墙上。
//
// core 那条腿按名有姓地跳过（"说不清类型的字面量：null" —— Option 那一族的旧账）。

module main

fn find(k int) ?int {
	if k > 0 {
		return k * 2
	}
	return none
}

fn twice(v int) int {
	return v + v
}

fn main() {
	println(twice(find(3) or { 0 }))
	println(twice(find(-1) or { 7 }))
	a := (find(4) or { 1 }) + 100
	println(a)
}
