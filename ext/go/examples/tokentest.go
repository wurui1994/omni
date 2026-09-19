// ext/go/examples/tokentest.go —— 从 go 编译器的 token 枚举摘出的核心逻辑
//
// 验证 iota 枚举、常量、切片索引、字符串切片、函数调用、位运算全走通。
// 与 go run 的输出逐行比对。
//
// 期望输出：
//   EOF
//   name
//   literal
//   break
//   var
//   unknown
//   true
//   false

package main

import "fmt"

const (
	tok_invalid = iota
	tok_EOF
	tok_Name
	tok_Literal
	tok_Operator
	tok_AssignOp
	tok_IncOp
	tok_Assign
	tok_Define
	tok_Arrow
	tok_Star
	tok_Lparen
	tok_Lbrack
	tok_Lbrace
	tok_Rparen
	tok_Rbrack
	tok_Rbrace
	tok_Comma
	tok_Semi
	tok_Colon
	tok_Dot
	tok_DotDotDot
	tok_Break
	tok_Case
	tok_Chan
	tok_Const
	tok_Continue
	tok_Default
	tok_Defer
	tok_Else
	tok_Fallthrough
	tok_For
	tok_Func
	tok_Go
	tok_Goto
	tok_If
	tok_Import
	tok_Interface
	tok_Map
	tok_Package
	tok_Range
	tok_Return
	tok_Select
	tok_Struct
	tok_Switch
	tok_Type
	tok_Var
	tok_count
)

var tokenNames string = "EOFnameliteralopop=opop=:=<-*([{)]},;:....breakcasechanconstcontinuedefaultdeferelsefallthroughforfuncgogotoifimportinterfacemappackagerangereturnselectstructswitchtypevar"

var tokenIdx []int = []int{0, 3, 7, 14, 16, 19, 23, 24, 26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 42, 47, 51, 55, 60, 68, 75, 80, 84, 95, 98, 102, 104, 108, 110, 116, 125, 128, 135, 140, 146, 152, 158, 164, 168, 171, 171}

func tokenString(i int) string {
	idx := i - 1
	if i < 1 || idx >= len(tokenIdx)-1 {
		return "unknown"
	}
	return tokenNames[tokenIdx[idx]:tokenIdx[idx+1]]
}

func contains(tokset int, tok int) bool {
	return tokset&(1<<tok) != 0
}

func main() {
	fmt.Println(tokenString(tok_EOF))
	fmt.Println(tokenString(tok_Name))
	fmt.Println(tokenString(tok_Literal))
	fmt.Println(tokenString(tok_Break))
	fmt.Println(tokenString(tok_Var))
	fmt.Println(tokenString(999))

	set := (1 << tok_Break) | (1 << tok_Continue)
	fmt.Println(contains(set, tok_Break))
	fmt.Println(contains(set, tok_Var))
}
