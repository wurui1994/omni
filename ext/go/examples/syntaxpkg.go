// ext/go/examples/syntaxpkg.go —— 验证 syntax 包的运行期行为
//
// 从 go 编译器 syntax 包摘出核心逻辑，在一个文件里组装调用。
// 验证 token 枚举、token 字符串化、operator 枚举、Pos 编码、
// 字符分类（isLetter/isDigit）、缓冲区增长全部正确。
//
// 期望输出与 go run 逐行一致。

package main

import "fmt"

// ---- tokens.go 摘出 ----
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

// ---- operator_string.go 摘出 ----
const (
	op_invalid = iota
	op_Def
	op_Not
	op_Recv
	op_Tilde
	op_OrOr
	op_AndAnd
	op_Eql
	op_Neq
	op_Lss
	op_Leq
	op_Gtr
	op_Geq
	op_Add
	op_Sub
	op_Or
	op_Xor
	op_Mul
	op_Div
	op_Rem
	op_And
	op_AndNot
	op_Shl
	op_Shr
)

var opNames string = ":!<-~||&&==!=<<=>>=+-|^*/%&&^<<>>"
var opIdx []int = []int{0, 1, 2, 4, 5, 7, 9, 11, 13, 14, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 31, 33}

func opString(i int) string {
	idx := i - 1
	if i < 1 || idx >= len(opIdx)-1 {
		return "unknown"
	}
	return opNames[opIdx[idx]:opIdx[idx+1]]
}

// ---- pos.go 摘出 ----
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

type Pos struct {
	basefile string
	line     int
	col      int
}

func MakePos(base PosBase, line int, col int) Pos {
	return Pos{basefile: base.filename, line: sat32(line), col: sat32(col)}
}

// ---- source.go 摘出 ----
func nextSize(size int) int {
	min := 4 << 10
	max := 1 << 20
	if size < min {
		return min
	}
	if size <= max {
		return size << 1
	}
	return size + max
}

// ---- scanner.go 摘出 ----
func isLetter(ch int) bool {
	return ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch == '_'
}

func isDigit(ch int) bool {
	return ch >= '0' && ch <= '9'
}

// ---- 关键字查表 ----
var keywordMap map[string]int

func initKeywords() {
	keywordMap = make(map[string]int)
	keywordMap["break"] = tok_Break
	keywordMap["case"] = tok_Case
	keywordMap["chan"] = tok_Chan
	keywordMap["const"] = tok_Const
	keywordMap["continue"] = tok_Continue
	keywordMap["default"] = tok_Default
	keywordMap["defer"] = tok_Defer
	keywordMap["else"] = tok_Else
	keywordMap["fallthrough"] = tok_Fallthrough
	keywordMap["for"] = tok_For
	keywordMap["func"] = tok_Func
	keywordMap["go"] = tok_Go
	keywordMap["goto"] = tok_Goto
	keywordMap["if"] = tok_If
	keywordMap["import"] = tok_Import
	keywordMap["interface"] = tok_Interface
	keywordMap["map"] = tok_Map
	keywordMap["package"] = tok_Package
	keywordMap["range"] = tok_Range
	keywordMap["return"] = tok_Return
	keywordMap["select"] = tok_Select
	keywordMap["struct"] = tok_Struct
	keywordMap["switch"] = tok_Switch
	keywordMap["type"] = tok_Type
	keywordMap["var"] = tok_Var
}

func lookupKeyword(name string) int {
	tok := keywordMap[name]
	return tok
}

// ---- 标识符扫描 ----
func scanIdent(src string) string {
	i := 0
	for i < len(src) {
		ch := int(src[i])
		if !isLetter(ch) && !isDigit(ch) {
			break
		}
		i = i + 1
	}
	return src[0:i]
}

func main() {
	// token 字符串化
	fmt.Println(tokenString(tok_EOF))
	fmt.Println(tokenString(tok_Break))
	fmt.Println(tokenString(tok_Var))
	fmt.Println(tokenString(999))

	// operator 字符串化
	fmt.Println(opString(op_Add))
	fmt.Println(opString(op_Eql))
	fmt.Println(opString(op_Shl))

	// Pos
	base := PosBase{filename: "test.go", line: 1, col: 1}
	pos := MakePos(base, 42, 7)
	fmt.Println(pos.line)
	fmt.Println(pos.col)
	fmt.Println(sat32(2000000000))

	// 缓冲区增长
	fmt.Println(nextSize(0))
	fmt.Println(nextSize(4096))

	// 字符分类
	fmt.Println(isLetter(int('x')))
	fmt.Println(isDigit(int('5')))
	fmt.Println(isLetter(int('9')))

	// 关键字查表
	initKeywords()
	fmt.Println(lookupKeyword("for"))
	fmt.Println(lookupKeyword("xyz"))

	// 标识符扫描
	fmt.Println(scanIdent("hello+world"))
	fmt.Println(scanIdent("_foo123 bar"))
}
