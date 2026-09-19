// ext/go/examples/postest.go —— 从 go 编译器的 Pos/PosBase 摘出的核心逻辑
//
// 验证 struct 嵌套、方法调用、nil 检查、条件返回、常量位运算。
// 期望输出与 go run 逐行一致。
//
// 期望输出：
//   1073741824
//   1073741824
//   100
//   test.go
//   10
//   20
//   true
//   false
//   test.go:10:20

package main

import "fmt"

const PosMax int = 1 << 30

func sat32(x int) int {
	if x > PosMax {
		return PosMax
	}
	return x
}

type PosBase struct {
	filename string
	line     int
	col      int
}

func NewFileBase(filename string) PosBase {
	return PosBase{filename: filename, line: 1, col: 1}
}

func PosBase_Filename(base PosBase) string {
	return base.filename
}

func PosBase_Line(base PosBase) int {
	return base.line
}

func PosBase_Col(base PosBase) int {
	return base.col
}

type Pos struct {
	basefile string
	line     int
	col      int
}

func MakePos(base PosBase, line int, col int) Pos {
	return Pos{basefile: base.filename, line: sat32(line), col: sat32(col)}
}

func Pos_IsKnown(pos Pos) bool {
	return pos.line > 0
}

func Pos_Line(pos Pos) int {
	return pos.line
}

func Pos_Col(pos Pos) int {
	return pos.col
}

func Pos_String(pos Pos) string {
	return fmt.Sprintf("%s:%d:%d", pos.basefile, pos.line, pos.col)
}

func main() {
	fmt.Println(PosMax)
	fmt.Println(sat32(2000000000))
	fmt.Println(sat32(100))

	base := NewFileBase("test.go")
	fmt.Println(PosBase_Filename(base))

	pos := MakePos(base, 10, 20)
	fmt.Println(Pos_Line(pos))
	fmt.Println(Pos_Col(pos))
	fmt.Println(Pos_IsKnown(pos))

	zero := Pos{basefile: "", line: 0, col: 0}
	fmt.Println(Pos_IsKnown(zero))

	fmt.Println(Pos_String(pos))
}
