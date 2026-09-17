// ext/vlang/examples/litnone.v —— **定长数组 · `none` · 三段 for 的空格子**（V 独一份）
//
// 期望输出：20 / 5 / 1 / 3。
//
// 三样各压一条，都是"同一个标签两件事"或"类型上的性质不进图"这一类：
//   * `[10, 20, 30]!` 是**定长数组**字面量 —— 元素都写出来了，落的还是那一格 list-new：
//     "定长"是**类型上**的性质，而类型不进图。
//   * `none` 是 V 的 Option 空值 -> 落 nil。**注意它与三段 for 里那个空格子是同一个标签**
//     `(none)`：所以 `for` 那一格要先把空格子滤掉 —— 条件那一格落成 nil 就是"条件为假"，
//     `for ;; {}` 会一次都不跑（答案错而不报）。
//   * `for ; k < 3; {}` —— 省掉的 init 与 post 在树上就是 `(none)`。
//   * `{'a': 1, 'b': 2}` 是**不写类型的 map 字面量** —— 与 `map[string]int{…}` 落同一格
//     map-new。**同一个标签 `map` 还是那格类型**（`map[K]V`），靠"孩子全是 kv"分开；
//     而"这个名字装的是 map"那张表要**两种写法都认**，漏一种后面 `m['b']` 就静静变成列表下标。
//   * `unsafe { … }` 是一格块：`unsafe` 本身**不产生代码**（只放开指针那几样的检查），
//     所以拆成一格 region —— 与 `mut` / `pub` 同一类。
//
// **明说一处**：真的 V 里 `?int` 的值要 `or { … }` 或 `?` 才拆得开，而这一批把 Option
// 那一层**类型丢掉了**（`ext/vlang/SPEC.md` §五第 1 项：option/result 排在后面一步）。
// 所以这一份里 `maybe(0)` 直接当 nil 用 —— 那是这一批的口径，不是 V 的完整语义。

module main

fn maybe(n int) ?int {
	if n > 0 {
		return n
	}
	return none
}

fn main() {
	xs := [10, 20, 30]!
	println(xs[1])
	a := maybe(5)
	println(a)
	b := maybe(0)
	if b == none {
		println(1)
	} else {
		println(0)
	}
	mut k := 0
	for ; k < 3; {
		k = k + 1
	}
	println(k)
	m := {
		'a': 1
		'b': 2
	}
	println(m['b'])
	unsafe {
		println(9)
	}
}
