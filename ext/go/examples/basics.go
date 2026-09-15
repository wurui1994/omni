// ext/go/examples/basics.go —— 与 chez / lua 那两份**同一件事**
//
// 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
// Go 这一份压两样前两门压不到的：
//   * **类型写在语法里**（`n int` / `) int {`）—— 而 type 不是节点，映射里直接丢掉；
//     它是端口的 sort，要用起来是契约 `carry` 那一问的事。
//   * **入口是 main** —— 图从上到下跑，所以映射末尾补一格 `call main`（语言的约定，不是节点）。
//
// 要素对照：
//   func + 形参表        -> bind + func
//   :=                   -> bind（decl 就是它）
//   =                    -> set
//   for init; cond; post -> region + loop + set（`for` 不给节点）
//   i++                  -> set + binop
//   if / else            -> branch
//   return               -> ret
//   fmt.Println          -> prim print

package main

import "fmt"

func sumto(n int) int {
	acc := 0
	for i := 1; i <= n; i++ {
		acc = acc + i
	}
	return acc
}

func fact(n int) int {
	if n == 0 {
		return 1
	}
	return n * fact(n-1)
}

func max2(a int, b int) int {
	if a > b {
		return a
	} else {
		return b
	}
}

func main() {
	fmt.Println(sumto(5))
	fmt.Println(fact(5))
	fmt.Println(max2(3, 7))
	tag := "ok"
	fmt.Println(tag)
}
