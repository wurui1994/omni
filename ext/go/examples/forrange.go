// ext/go/examples/forrange.go —— **`for … range` 落一格计数循环**（go 独一份的家族）
//
// 期望输出：80 / 3 / 30 / 32 / 9。
//
// 单开一个家族的理由与 `switch.go` 同一条：**一格新节点都没加** —— `range` 落的是现成的
// `counted`（一格 region 装着起始的 bind 与一格 loop，步进走 post 端口）。五行各压一样：
//   * `for i, v := range xs` —— 第一格是**下标**、第二格是那一格**元素**（index-get）；
//   * `for range xs` —— 两格都不要，只按长度转；
//   * `for _, v := range xs` —— `_` 那一格不绑名字；
//   * `for j, e = range xs` —— `=` 出 set（名字在循环外面就有了），`:=` 出 bind；
//   * 嵌一层 —— 里外两格临时量各用自己的号（`__rg0` / `__rg1`）。
//
// 序列与长度都**只算一次**（go 的规范就是这么说的），所以图上是两格 bind 而不是每轮重算。

package main

import "fmt"

func main() {
	xs := []int{10, 20, 30}
	sum := 0
	for i, v := range xs {
		sum = sum + i*v
	}
	fmt.Println(sum)
	n := 0
	for range xs {
		n = n + 1
	}
	fmt.Println(n)
	last := 0
	for _, v := range xs {
		last = v
	}
	fmt.Println(last)
	j := 0
	e := 0
	for j, e = range xs {
	}
	fmt.Println(j + e)
	t := 0
	for range xs {
		for range xs {
			t = t + 1
		}
	}
	fmt.Println(t)
}
