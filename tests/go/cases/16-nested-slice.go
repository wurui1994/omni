// 嵌套切片字面量 + **省掉类型的内层字面量**（go 允许 `[][]int{{1,2},{3}}`）。
//
// 这一份钉两件事：
//   * 内层 `{…}` 省掉类型时，第一个**元素**不能被当成类型吃掉 —— 从前
//     `{1,2}` 静静落成 `[2]`（答案错而不报），`{}` 则报"一格空列表"；
//   * `(arr (arr int))` 这一形在方言里是现成的：`aget`/`alen` 套两层都成立。
//
// pt 的 `triangleTable`（marching cubes 那张 256 行的表）就是这个形状。
package main

var tt = [][]int{
	{},
	{1, 2},
	{3, 4, 5},
}

func main() {
	println(len(tt))
	println(len(tt[0]))
	println(len(tt[1]))
	s := 0
	for _, r := range tt {
		for _, v := range r {
			s += v
		}
	}
	println(s)
}
