//omni:pkgs src/lib/go/omnihost,src/lib/go/time,src/lib/go/runtime,src/lib/go/path
// `time` / `runtime` / `path` 那三份桩。
//
// **印不出绝对时间**：`time.Now()` 在两边本来就不一样（我们那份装的是单调钟的纳秒数，
// 见桩的文件头）。所以这一格问的是**说得出口的那几件事**：钟在走、时长换算对、
// 核数 > 0、路径切得对 —— 两边都印同一串字节。
package main

import (
	"path"
	"runtime"
	"time"
)

func main() {
	if runtime.NumCPU() > 0 {
		println("cpu ok")
	}
	start := time.Now()
	n := 0
	for i := 0; i < 2000000; i++ {
		n += i % 7
	}
	println(n)
	d := time.Since(start)
	if d.Nanoseconds() > 0 {
		println("clock ok")
	}
	if d.Seconds() < 60 {
		println("fast")
	}
	var h time.Duration = 3661 * time.Second
	println(int(h.Hours()))
	println(int(h.Minutes()))
	println(int(h.Seconds()))
	dir, f := path.Split("a/b/c.png")
	println(dir + "|" + f)
	println(path.Base("x/y.z"))
	println(path.Dir("x/y.z"))
	println(path.Join("a/b", "c.png"))
}
