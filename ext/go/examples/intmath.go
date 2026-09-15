// ext/go/examples/intmath.go —— 与 ext/lua/examples/intmath.lua **同一件事**
//
// 期望输出逐行相同：15 / 120。
// 与那一份一样刻意贫瘠 —— 这是 wasm 那条腿现在能接住的子集（设计文档 §9）。

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

func main() {
	fmt.Println(sumto(5))
	fmt.Println(fact(5))
}
