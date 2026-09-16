// ext/go/examples/strcat.go —— 与 lua / nim / V 那三份 strcat **同一件事**
//
// 期望输出逐行相同：ab / hi there。
// go 用 `+` 接串（与数的 `+` 同一个算符）—— 落到的那一格由**操作数的种类**定：
// 两边是串就是串接。图上不为它开新节点（内建表里 `+` 与 `concat` 各一行）。

package main

import "fmt"

func main() {
	fmt.Println("a" + "b")
	s := "hi"
	fmt.Println(s + " " + "there")
}
