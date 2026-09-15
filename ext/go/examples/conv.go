// ext/go/examples/conv.go —— **表示转换**那一格（第八个例子家族）
//
// 期望输出（家族里所有语言、所有后端逐行相同）：2 / 3.5。
//
// go 的 12 格 `Op`（OCONV / OCONVIFACE / OCONVNOP …）塌成图上**一格 `conv`**：
// 目标类型是一格**附属**（`to`），不是端口 —— 类型不进图那条规矩在这一格也成立。
// 两行各压一格：`int(…)` 是"往整数那一侧"、`float64(…)` 是"往实数那一侧"。

package main

import "fmt"

func main() {
	fmt.Println(int(7.0 / 3.0))
	fmt.Println(float64(7) / 2)
}
