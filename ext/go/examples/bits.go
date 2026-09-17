// ext/go/examples/bits.go —— **位运算那六格内建**（go 与 V 同一族）
//
// 期望输出：8 / 14 / 6 / 6 / -13。
//
// 账上算出来的一族（三门合起来 64 份印"这个算子还没接：`&` / `|` / `^` / `<<` / `shl`"）。
// 落的是**六格内建**（`band` / `bor` / `bxor` / `bnot` / `shl` / `shr`），一格节点也没加。
//
// **名字为什么用词不用符号**：图上的 `^` 早就是**幂**（`prims.js` 里 `P('^')`），
// 而 go 的 `^` 是 xor、V 的 `^` 也是 xor —— 两门语言的符号都撞在幂上，所以内建那一格用词。
// 各门语言的符号由自己的算符表映过去（`fromtree.js` 的公共表 + 各自的 delta）。
//
// **算在 64 位上**：interp 与 js 那两条腿算在 BigInt 上再折回 Number（js 的 `&` / `<<`
// 是 32 位的，`1 << 40` 会得 256），c 那条腿是 `long long`、wat 那条腿是 i64、
// 方言那侧本来就是 64 位整数 —— **六条腿逐字节相同**。
//
// go 自己那两格（`<<` 与 `&^`）在 `bitsgo.go` 那一族里判：V 的 `<<` 是列表追加，
// 摆不进同一族的期望输出里。

package main

import "fmt"

func main() {
	a := 12
	b := 10
	fmt.Println(a & b)
	fmt.Println(a | b)
	fmt.Println(a ^ b)
	fmt.Println(48 >> 3)
	fmt.Println(^a)
}
