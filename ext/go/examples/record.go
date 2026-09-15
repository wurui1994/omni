// ext/go/examples/record.go —— **record 那一族**（第四个例子家族）
//
// 期望输出（这个家族里所有语言、所有后端逐行相同）：1 / 5 / 6。
//
// 三格节点各压一行：
//   `Point{x: 1, y: 2}` -> record-new（有名字的字段表 —— **类型名不进图**）
//   `p.x`               -> field-get
//   `p.y = 5`           -> field-set

package main

import "fmt"

type Point struct {
	x int
	y int
}

func main() {
	p := Point{x: 1, y: 2}
	fmt.Println(p.x)
	p.y = 5
	fmt.Println(p.y)
	fmt.Println(p.x + p.y)
}
