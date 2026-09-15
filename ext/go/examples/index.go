// ext/go/examples/index.go —— 与 ext/lua/examples/index.lua **同一件事**
//
// 期望输出逐行相同：10 / 30 / 45。
// go 的下标从 0 起、lua 从 1 起 —— 源码不同，落到的图**同形**（起点由映射摆平）。

package main

import "fmt"

func main() {
	xs := []int{10, 20, 30}
	fmt.Println(xs[0])
	fmt.Println(xs[2])
	xs[1] = 5
	s := 0
	for i := 0; i < 3; i++ {
		s = s + xs[i]
	}
	fmt.Println(s)
}
