// ext/vlang/examples/member.v —— **`x in 数组` 落一格内建 `contains`**（V 与 nim 同一族）
//
// 期望输出：true / false / true / false。
//
// 这一格是账上算出来的（`bench/tograph.js` 印"这个算子还没接：in" —— V 20 份 + nim 5 份），
// 落的是**一格内建 `prim contains`**（线性扫找元素），照的是 `push` 的分类：
// 两格实参都是普通的值，没有"哪一格是什么角色"要分 -> 内建，不是节点。
//
// 同一个 `in` 在 V 里**落到两格不同的东西**，这一份只管其中一格：
//   * 数组上的 `in` -> `prim contains`（找的是**元素**）—— 就是这一份；
//   * map 上的 `in`  -> `map-has`（找的是**键**）—— 那一格在 `dict` 那一族里判着。
// 分不开就是一种错而不报：拿 contains 去扫一格 map，扫到的是它的键值对，答案会一律是 false。
// 所以映射里先查"这个名字装的是不是 map"（`MAPS`），是才走 map-has。
//
// `!in` / nim 的 `notin` 不是另一格：它是 `not(contains(…))`。

module main

fn main() {
	xs := [10, 20, 30]
	println(20 in xs)
	println(7 in xs)
	println(7 !in xs)
	println(20 !in xs)
}
