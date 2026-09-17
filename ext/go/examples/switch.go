// ext/go/examples/switch.go —— **`switch` 落一条 branch 链**（go 独一份的家族）
//
// 期望输出：10 / 20 / 30 / 2 / 4 / 3。
//
// 单开一个家族的理由与 `vardecl.go` 同一条：**一格新节点都没加**。go 的 switch 与 C 家族
// 差得远（**没有隐式贯穿**），所以它就是一串 if / else if / else —— 而"落成 branch 链"
// 这句话有三处只有 go 说得清，这一份把它们逐条压住：
//   * `case 2, 3:` —— 一个分支几个值 = 或（落 `lazyOr`，第二格 lazy）；
//   * `switch { case cond: }` —— 没主语那一路直接拿表达式当条件；
//   * `default` 写在**中间**也垫底（条件按源码次序判）；
//   * `switch k := …; k` —— 头上那一格 init 与主语的临时量同在一格 region 里；
//   * 嵌一层的那个 switch 换个临时量号（`__sw0` / `__sw1`）。
//
// 只用整数：这样五条腿都跑得动（wat 那条腿的宿主面只有 print_i64 之外的一格串）。

package main

import "fmt"

func kind(n int) int {
	switch n {
	case 1:
		return 10
	case 2, 3:
		return 20
	default:
		return 30
	}
}

func sign(n int) int {
	switch {
	case n > 0:
		return 1
	case n < 0:
		return 2
	}
	return 0
}

func main() {
	fmt.Println(kind(1))
	fmt.Println(kind(3))
	fmt.Println(kind(9))
	fmt.Println(sign(0 - 5))
	switch k := 2 * 2; k {
	default:
		fmt.Println(0)
	case 4:
		fmt.Println(k)
	}
	switch a := 1; a {
	case 1:
		switch b := 2; b {
		case 2:
			fmt.Println(a + b)
		}
	}
}
