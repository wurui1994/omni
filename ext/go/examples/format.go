// ext/go/examples/format.go —— **格式串落成一格 `concat`**（go 独一份的家族）
//
// 期望输出：k=7 / a=1 b=z / 100% / 42。
//
// 这一族先堵一个**答案错而不报**：`Printf` 原来在"都落 print"那张表里，于是
// `fmt.Printf("x=%d\n", 3)` 会印成 `x=%d\n 3` —— 格式串被当成了第一个要印的东西。
//
// 落法：格式串在这一层读出来，落成一格 **`concat`**（那格内建本来就是"把各格印出来接起来"）。
// 只接三格动词，别的**当场报**（不猜宽度、精度、进制 —— 那几样要一台真的格式化机器）：
//   `%d` 整数 · `%s` 串 · `%v` 按 show 印 —— 在图上这三格是同一件事；`%%` 一个百分号。
//
// `Printf` **自己不换行**，而图上那格 `print` 换行 —— 所以格式串以 `\n` 收尾时把它去掉
// （两边正好对上）；不以 `\n` 收尾的这一批接不了（图上没有"不换行的印"那一格），当场报。
//
// `fmt.Errorf` 交出来的在 go 里是 `error` 不是 string —— 这一批把那一层类型丢掉了，
// 所以它与 `Sprintf` 落同一格。

package main

import "fmt"

func label(n int, s string) string {
	return fmt.Sprintf("%s=%d", s, n)
}

func main() {
	fmt.Println(label(7, "k"))
	fmt.Printf("a=%d b=%s\n", 1, "z")
	fmt.Printf("100%%\n")
	fmt.Println(fmt.Sprintf("%v", 42))
}
