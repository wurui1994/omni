// ext/go/examples/makelen.go —— **`make([]T, n)` 落一格内建 `fill`**（go 独一份）
//
// 期望输出：4 / 0 / 7 / 2。
//
// 账上算出来的（16 份）。落的是**一格内建**（`fill(n, 元素的零值)`），照 `push` / `contains`
// 的分类：两格实参都是普通的值（长度、每格的初值）—— 列表上的一个库函数，不是节点。
//
// 元素的零值走的还是 `zeroOf` 那一格（`var x int` 那一刀定的那张表），所以
// `make([]string, 2)` 里每格是空串、`make([]int, n)` 里每格是 0。
//
// **一条约束两边对上了**：`fill` 只接**标量初值** —— js 的 `Array(n).fill(obj)` 是 n 格
// 指向同一格对象，而 go 的 `make([]T, n)` 给的是 n 格各自的零值。具名结构体的零值在映射
// 那一层本来就当场报（`vardecl` 那一刀定的），所以这一格永远拿不到聚合初值。
//
// wat 与 core 两条腿按名有姓地欠着（那两侧要一格循环才造得出按长度的列表）。

package main

import "fmt"

func main() {
	n := 4
	xs := make([]int, n)
	fmt.Println(len(xs))
	fmt.Println(xs[0])
	xs[2] = 7
	fmt.Println(xs[2])
	ss := make([]string, 2)
	fmt.Println(len(ss))
}
