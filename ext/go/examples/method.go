// ext/go/examples/method.go —— **方法那一族**（与 nim 那一份同一件事）
//
// 期望输出（家族里所有语言、所有后端逐行相同）：3 / 9 / 3。
//
// go 的接收者写在声明里（`func (p Point) total() int`），所以图上只是
// **多一格实参的普通函数** —— 方法不是一格新节点，分派也不查表。
// 最后一行 `Point.total(p)` 是 go 自己的方法表达式：它与 `p.total()` 是同一张图，
// 这一行就是"接收者只是第一格实参"那句话的判据。

package main

import "fmt"

type Point struct {
	x int
	y int
}

func (p Point) total() int {
	return p.x + p.y
}

func (p Point) scaled(k int) int {
	return p.total() * k
}

func main() {
	p := Point{x: 1, y: 2}
	fmt.Println(p.total())
	fmt.Println(p.scaled(3))
	fmt.Println(Point.total(p))
}
