// ext/go/examples/defer.go —— **scope-exit** 那一格的例子（第三个例子家族）
//
// 期望输出（与 ext/sbcl/examples/defer.lisp 逐行相同）：
//   in
//   b
//   a
//   out
//
// 三条语义各压一格，而且三条都由调度器给、不由语言给：
//   注册那一刻记下动作 · 宿主 region 出口时**逆序**跑 · **早退（return）也跑**

package main

import "fmt"

func demo() {
	defer fmt.Println("a")
	defer fmt.Println("b")
	fmt.Println("in")
	return
}

func main() {
	demo()
	fmt.Println("out")
}
