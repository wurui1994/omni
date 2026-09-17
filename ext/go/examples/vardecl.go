// ext/go/examples/vardecl.go —— **`var` / `const` 那一族**（go 独一份的家族）
//
// 期望输出：15 / 1 / 3 / 6。
//
// 单开一个家族的理由与 `deferarg.go` 同一条：**落到的节点一格新的都没有**（全是 bind），
// 而 go 在这一格上有三条别人写不出来的规矩，全归这门语言的映射摆平：
//   * `var z int` —— 只写类型不写初值，那时它是**零值**（`int` 是 0）；
//   * const 组里**省略初值就重复上一条**（`red` / `green` 抄的是 `_ = iota` 那一句）；
//   * `iota` 是**这一条 spec 在组里的序号**，所以重复的那几条各拿自己的号；
//     `_` 是空位 —— 那一格不绑名字。
//
// 顶层的 `var` 是**模块级变量**（图上就是 `call main` 之前的几格 bind）。
//
// 末尾三段压的是另外三样：
//   * `var arr [3]int` —— **定长数组的零值是 N 格元素零值各一格**（数组是值语义的）；
//   * `make(map[K]V)` 与 `make([]T, 0)` —— **第一格实参是一格类型**，所以这一格要在
//     "先算实参"之前拦；而"这名字装的是 map"那张表要**两种造法都认**（字面量与 make），
//     漏一种 `m["k"] = 5` 就静静变成列表下标写；
//   * `len(xs)` 落 `prim len` —— 与 lua 的 `#s`、awk 的 `length(s)` 同一格节点。
//
// 中间两段压的是**语句头上的那几格声明位**（同一条产生式上的可选格子）：
//   * `if v := …; cond` —— init 的作用域是**整条 if 链**，所以落成 region 包着 branch；
//   * `for ; cond ;` —— 省掉的格子在树上是 `(none)`，它不是节点。

package main

import "fmt"

var start = 10
var step int = 5
var zero int

const one = 1

const (
	_ = iota
	red
	green
)

func main() {
	var n = start + step
	fmt.Println(n)
	fmt.Println(zero + one)
	fmt.Println(red + green)
	var i, j = 2, 3
	fmt.Println(i * j)
	if v := i + j; v > 4 {
		fmt.Println(v)
	} else {
		fmt.Println(v * 10)
	}
	k := 0
	for ; k < 2; {
		k = k + 1
	}
	fmt.Println(k)
	var arr [3]int
	arr[1] = 7
	fmt.Println(arr[0] + arr[1] + arr[2])
	m := make(map[string]int)
	m["k"] = 5
	fmt.Println(m["k"])
	xs := make([]int, 0)
	fmt.Println(len(xs))
}
