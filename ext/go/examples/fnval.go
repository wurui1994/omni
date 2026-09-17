// ext/go/examples/fnval.go —— **匿名函数当值用**（`func(){…}` 落那格现成的 `func`）
//
// 期望输出：42 / 15 / 9。
//
// 这一格是账上第五大的一族（go 60 份 + V 92 份印的都是"这一格还没接：fnlit"），而它
// **一格新节点也不用加**：`func` 在节点清单里本来就是**表达式**（`nodes.js` 里它的 sort
// 是 expr，chez 的 lambda 就是这么落的）—— 从前只是这门映射没接那条产生式。
// 名字是附属，匿名的现取一个（`__fnN`，按文件从 0 数起 —— 同一份源码要落出同一张图）。
//
// 三种用法这一份都压着：绑给一个名字再调、**当实参传进去**、当场就调（IIFE）。
// 两条腿按名有姓地欠着：c 那条欠"按值调用要一格函数指针表"、core 那条欠"func 在表达式
// 位置上"——两条本来就在形状账里，不是这一刀新欠的。

package main

import "fmt"

func apply(f func(int) int, v int) int {
	return f(v)
}

func main() {
	inc := func(x int) int { return x + 1 }
	fmt.Println(inc(41))
	fmt.Println(apply(func(x int) int { return x * 3 }, 5))
	fmt.Println(func(a int, b int) int { return a + b }(4, 5))
}
