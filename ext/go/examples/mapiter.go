// ext/go/examples/mapiter.go —— **按键遍历**（第三十个例子家族，图那一层的 `map-keys`）
//
// 期望输出（家族里所有语言、所有后端逐行相同）：
//   a
//   b
//   c
//   3
//   9
//
// 三行 + 两个数各压一格：
//   * `for k := range m` —— 一个名字给的是**键**（与 range 一格切片那一格正相反：
//     那儿第一格是**下标**）。前三行同时钉住**次序 = 插入序**：go 的规范说 map 的
//     迭代次序是不定的，所以"某个固定次序"是它的一个合法实现，而六条腿必须是**同一个**；
//   * `for range m` —— 两格名字都不要，只按键数转（这一行证"键的列表"真的出来了）；
//   * `for _, v := range m` —— 第二格是**值**（走 `map-get`，键一定在，所以缺键那条规矩
//     碰不到）。
//
// **一格新的循环节点都没加**：`map-keys` 出一格列表，往下走的是列表 for-each 那份
// 现成的 `counted`（region + bind + loop + `prim len` + `index-get`）——
// 于是"遍历"这件事在图那一层只有一份降级代码。

package main

import "fmt"

func main() {
	m := map[string]int{"a": 1, "b": 3}
	m["c"] = 5
	for k := range m {
		fmt.Println(k)
	}
	n := 0
	for range m {
		n = n + 1
	}
	fmt.Println(n)
	sum := 0
	for _, v := range m {
		sum = sum + v
	}
	fmt.Println(sum)
}
