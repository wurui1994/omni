// ext/go/examples/multi.go —— 与 ext/lua/examples/multi.lua **同一件事**
//
// 期望输出逐行相同：3 / 7 / 1 2。
// Go 这一份多压一格 lua 没有的：**多值直接当实参**（`fmt.Println(minmax(1, 2))`
// 在 Go 里合法），所以"列表里只有最后一格展开"那条 arity 契约两门语言一起验。

package main

import "fmt"

func minmax(a int, b int) (int, int) {
	if a < b {
		return a, b
	}
	return b, a
}

func main() {
	lo, hi := minmax(7, 3)
	fmt.Println(lo)
	fmt.Println(hi)
	fmt.Println(minmax(1, 2))
}
