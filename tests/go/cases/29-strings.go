//omni:pkgs src/lib/go/strings
// `strings` 那份桩：Index / Contains / Fields / Split / Join / TrimSpace / HasPrefix / HasSuffix。
// 参考是**真的 go 标准库**（`go run` 那一边），所以这一格量的是"桩写对了没有"。
package main

import "strings"

func main() {
	println(strings.Index("hello world", "o w"))
	println(strings.Index("abc", "z"))
	println(strings.Index("abc", ""))
	if strings.Contains("out%03d.png", "%") {
		println("has pct")
	}
	fs := strings.Fields("  a bb   ccc ")
	println(len(fs))
	println(fs[0] + "|" + fs[1] + "|" + fs[2])
	ps := strings.Split("1/2/3", "/")
	println(len(ps))
	println(strings.Join(ps, "-"))
	es := strings.Split("a,,b", ",")
	println(len(es))
	println("[" + strings.TrimSpace("  \t xy \n ") + "]")
	if strings.HasPrefix("vertex", "ver") {
		println("prefix ok")
	}
	if strings.HasSuffix("a.png", ".png") {
		println("suffix ok")
	}
}
