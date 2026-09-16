// ext/go/examples/dict.go —— **map / dict 那四格**的例子（第十二个例子家族）
//
// 期望输出（家族里所有语言、所有后端逐行相同）：
//   1
//   3
//   4
//   yes
//
// 四行各压一格：`map-new`（字面量里两格键值）· `map-get` · `map-set`（长出一格新键）
// · `map-has`。**键是值不是名字** —— 那正是它与 `record-new` 分开的理由之一。
//
// go 这一份还压住一条"不必回问类型"：`m["a"]` 与 `xs[0]` 在树上同形，
// 但 map 字面量自带标记（`(lit (map …) …)`），所以映射自己扫一遍绑定就分得开 ——
// 那笔"驱动器要能回问'这名字登记成类型了吗'"的账，在这一格上是不必的。

package main

import "fmt"

func main() {
	m := map[string]int{"a": 1, "b": 3}
	fmt.Println(m["a"])
	fmt.Println(m["b"])
	m["c"] = 4
	fmt.Println(m["c"])
	_, ok := m["a"]
	if ok {
		fmt.Println("yes")
	}
}
