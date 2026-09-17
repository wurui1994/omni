// ext/go/examples/bitsgo.go —— **go 自己那两格位运算**（`<<` 与 `&^`）
//
// 期望输出：48 / 4。
//
// 单开一族的理由与 `deferarg` 同一条：**别的语言写不出这个形状**。
//   * `<<` 在 V 里是列表追加（那一族在 `push`），所以它进不了 `bits` 那一族的期望输出；
//   * `&^`（and-not）是 go 独一份的算符 —— 落的是 `band(a, bnot(b))` 两格现成的内建，
//     **不给它开一格**（"写法归语言、格子归节点"的又一例）。

package main

import "fmt"

func main() {
	fmt.Println(3 << 4)
	fmt.Println(12 &^ 10)
}
