// ext/go/examples/slice.go —— **切片**那一格（第九个例子家族）
//
// 期望输出（家族里所有语言、所有后端逐行相同）：20 / 30。
//
// 四门语言四种写法（go `xs[1:3]` / V `xs[1..3]` / nim `xs[1 .. 2]` / mojo `xs[1:3]`）
// 落**同一格** slice。图上的规矩只有两条：**上界不含、下标 0 起** ——
// nim 那个"含上界"的差由 nim 自己的映射 +1，与"下标起点是语言的事"同一条纪律。

package main

import "fmt"

func main() {
	xs := []int{10, 20, 30, 40}
	ys := xs[1:3]
	fmt.Println(ys[0])
	fmt.Println(ys[1])
}
