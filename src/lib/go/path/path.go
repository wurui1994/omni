// src/lib/go/path/path.go —— `path` 的**子集**（pt 的 `RelativePath` 用那两格）。
//
// 按 `/` 切，纯串操作。与 `path/filepath` 不同：这一份不管 Windows 的反斜杠，
// go 的 `path` 也不管。
//
// **故意不 import `strings`**：`--pkgs` 那条路把依赖包摊进**同一个平名字空间**，而
// `strings` 与 `path` 都有一格叫 `Split` 的顶层函数 —— 两份一起编时后绑的那格会盖掉
// 前一格（症状：`d, f := path.Split(…)` 报 `pick 的来源不是一格多值`，因为查到的是
// `strings.Split` 那格单返回的签名）。所以这一份自己写那两行尾斜杠判断。

package path

// Split 把路径切成"目录（带尾斜杠）"与"最后那一段"。
func Split(p string) (string, string) {
	i := -1
	for k := 0; k < len(p); k++ {
		if p[k:k+1] == "/" {
			i = k
		}
	}
	if i < 0 {
		return "", p
	}
	return p[0 : i+1], p[i+1 : len(p)]
}

// Join 把两段用 `/` 接起来。
//
// **两处与 go 不同**：
//   * go 的是变参 `Join(elem ...string)`，这一份收两格 —— 变参那一格的形参类型这条腿
//     还按**元素类型**算（`elem` 推出来是 string 而不是 []string），于是 `elem[i]` 报
//     "在一格说不清形状的东西上取下标"。pt 只用两段（`path.Join(dir, path2)`）。
//   * **不做 `Clean`**（`a/../b` 不收成 `b`）。
func Join(a string, b string) string {
	if len(a) == 0 {
		return b
	}
	if len(b) == 0 {
		return a
	}
	if a[len(a)-1:len(a)] == "/" {
		return a + b
	}
	return a + "/" + b
}

// Base 是最后那一段。
func Base(p string) string {
	_, b := Split(p)
	return b
}

// Dir 是前面那一段（不带尾斜杠；空的时候是 `.`）。
func Dir(p string) string {
	d, _ := Split(p)
	if len(d) == 0 {
		return "."
	}
	if len(d) > 1 {
		return d[0 : len(d)-1]
	}
	return d
}
