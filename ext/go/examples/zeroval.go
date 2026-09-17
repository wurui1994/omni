// ext/go/examples/zeroval.go —— **零值那一族**（go 独一份的家族）
//
// 期望输出：4 / 0 / 0 / 0 / true。
//
// `var x T` 的零值是 go 的一条实语义，而它在图上要**从声明来**：
//   * **具名 struct** 的零值是"每个字段各自的零值" —— 字段名与顺序从 `type X struct{…}`
//     登记（`STRUCTS`）。这是"名字与顺序从声明来"那条既有路子的又一处（V 的位置型字面量、
//     mojo 的 `@value struct`、CL 的 `defstruct`、Scheme 的 `define-record-type`、
//     FB 的 `Type` 都是它）—— 所以图上**一格新节点都没加**，落的是 record-new。
//   * **嵌套**（`Pair` 里装着 `Point`）就是递归一层。
//   * **匿名 struct**（`var x struct{ n int }`）走同一条路 —— 字段表就在那一格类型里。
//   * **别的具名类型**（`type Level int` / `type Name = string`）的零值就是**底子的零值**
//     —— 那是一层间接（`UNDER`），不是新语义。
//
// 三处当场报，不猜：有**嵌入字段**的 struct（它在零值里占几格要展开被嵌类型才知道）、
// 声明**不在这一份文件里**的类型（跨模块）、`[N]T` 里 N 不是整数字面量。

package main

import "fmt"

type Point struct {
	x int
	y int
}

type Pair struct {
	a Point
	s string
}

type Level int

type Name = string

func main() {
	var p Point
	p.y = 4
	fmt.Println(p.x + p.y)
	var q Pair
	fmt.Println(q.a.y)
	var anon struct {
		n int
	}
	fmt.Println(anon.n)
	var lv Level
	fmt.Println(lv)
	var nm Name
	fmt.Println(nm == "")
}
