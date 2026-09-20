// `map[string]*T` —— 值是**引用语义的记录**（方言里就是一格类，格子里躺一个句柄）。
//
// 这一份钉三件事：
//   * 模块级 `var reg = map[string]*Node{}` 的键值类型从**声明**来
//     （`map-new` 的 `kzero` / `vzero`，#40）—— 从前 core 那侧只往"这一层的语句序"里
//     找第一处 `map-set`，而写在 `get` 的体里，于是报"键值类型推不出来"；
//   * `reg[k] = n` 的值是一格整格的记录（`aggValText`）；
//   * 取出来的还是**同一格**（引用语义）：改 a.Count，b 看得见。
package main

type Node struct {
	Name  string
	Count int
}

var reg = map[string]*Node{}

func get(k string) *Node {
	if _, ok := reg[k]; !ok {
		reg[k] = &Node{k, 0}
	}
	return reg[k]
}

func main() {
	a := get("x")
	a.Count = 5
	b := get("x")
	println(b.Count)
	println(len(reg))
	println(get("y").Name)
	println(len(reg))
}
