// ext/go/examples/deferarg.go —— **go 独有的那一条：defer 的实参在注册那一刻就算掉**
//
// 期望输出（这个家族只有 go 一门 —— 别的语言 defer 的是一整块语句，语义不同）：
//   2
//   1
//
// 与 ext/go/examples/defer.go 的差别只有一格：那份 defer 的是常量，
// 所以"什么时候求值"看不出来；这一份在注册之后**改了那个变量**，于是两种语义分得开：
//   * 注册时求值（go）：印 1
//   * 出口时求值（CL 的 unwind-protect / nim 与 V 的 defer 块）：印 2
//
// 图上不为这一条加节点：实参先 `bind` 到一格临时名字（bind 就是"这一刻算"），
// 动作里用 `ref` 那个名字 —— 见 src/core/graph/fromtree.js 的 deferNow。

package main

import "fmt"

func demo() {
	i := 1
	defer fmt.Println(i)
	i = 2
	fmt.Println(i)
}

func main() {
	demo()
}
