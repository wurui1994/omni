// **缺键的读**：go 的 `m[k]` 与 `v, ok := m[k]` 在键不在时给**零值**，
// 而方言的 `dget` 缺键是运行期错误（`nodes.js` 上 `map-get` 那句"默认值归语言"）。
// 从前这两样都是 abort —— 一格**答案错到 abort** 的坑，计数 map 那一族躲不开。
//
// 值不是标量的那一档（`map[K]*T` / `map[K]接口`）**刻意不这么落**：go 的零值是 nil，
// 而图上没有 nil 记录，糊一格新的零值记录进去就是静默的错答案。那一档照旧运行期报。
package main

func main() {
	m := map[string]int{"a": 1}
	println(m["a"])
	println(m["zz"])
	v, ok := m["zz"]
	println(v)
	println(ok)
	w, ok2 := m["a"]
	println(w)
	println(ok2)

	// 计数那一族：`cnt[c]++` 靠的正是"缺键读成 0"
	cnt := map[string]int{}
	for _, c := range []string{"x", "y", "x", "x"} {
		cnt[c] = cnt[c] + 1
	}
	println(cnt["x"])
	println(cnt["y"])
	println(cnt["z"])
	println(len(cnt))

	// 串值的零值是空串
	s := map[int]string{}
	println(len(s[7]))
}
