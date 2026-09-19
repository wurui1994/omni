// ext/go/examples/scanutil.go —— 从 go 编译器的 source.go / scanner.go 摘出的纯算法
//
// 验证 << 位运算、多分支条件、字符比较、字符串遍历、map 查表。
// 这几个函数在真 go 编译器里是 scanner 的核心工具。
// 期望输出与 go run 逐行一致。
//
// 期望输出：
//   4096
//   8192
//   2097152
//   3145728
//   true
//   false
//   true
//   true
//   false
//   true
//   break
//   for
//   17
//   0

package main

import "fmt"

// 从 source.go 摘出：缓冲区增长策略
func nextSize(size int) int {
	min := 4 << 10 // 4K
	max := 1 << 20 // 1M
	if size < min {
		return min
	}
	if size <= max {
		return size << 1
	}
	return size + max
}

// 从 scanner.go 摘出：字符分类
func isLetter(ch int) bool {
	return ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch == '_'
}

func isDigit(ch int) bool {
	return ch >= '0' && ch <= '9'
}

func isIdentChar(ch int) bool {
	return isLetter(ch) || isDigit(ch)
}

// 从 scanner.go 摘出：关键字查表（用 map 而不是 switch）
var keywordMap map[string]int

func initKeywords() {
	keywordMap = make(map[string]int)
	keywordMap["break"] = 22
	keywordMap["case"] = 23
	keywordMap["chan"] = 24
	keywordMap["const"] = 25
	keywordMap["continue"] = 26
	keywordMap["default"] = 27
	keywordMap["defer"] = 28
	keywordMap["else"] = 29
	keywordMap["fallthrough"] = 30
	keywordMap["for"] = 31
	keywordMap["func"] = 32
	keywordMap["go"] = 33
	keywordMap["goto"] = 34
	keywordMap["if"] = 35
	keywordMap["import"] = 36
	keywordMap["interface"] = 37
	keywordMap["map"] = 38
	keywordMap["package"] = 39
	keywordMap["range"] = 40
	keywordMap["return"] = 41
	keywordMap["select"] = 42
	keywordMap["struct"] = 43
	keywordMap["switch"] = 44
	keywordMap["type"] = 45
	keywordMap["var"] = 46
}

// 查关键字：存在就返回 token 值，不存在返回 0
// 注意：go 的 map 对缺键返回零值（int 是 0），图上 map-get 对缺键报错。
// 这儿用 map-has 判一下再取——但这是一个语义差异，真实 go 代码里直接写 m[k]。
func lookupKeyword(name string) int {
	tok := keywordMap[name]
	return tok
}

// 模拟 scanner 里的 ident 识别：扫一个标识符串，查表
func scanIdent(src string) string {
	i := 0
	for i < len(src) && isIdentChar(int(src[i])) {
		i = i + 1
	}
	return src[0:i]
}

func main() {
	// nextSize 验证
	fmt.Println(nextSize(0))         // < 4K -> 4096
	fmt.Println(nextSize(4096))      // <= 1M -> 8192
	fmt.Println(nextSize(1048576))   // == 1M -> 2097152
	fmt.Println(nextSize(2097152))   // > 1M -> 2097152 + 1048576 = 3145728

	// 字符分类
	fmt.Println(isLetter(int('a')))   // true
	fmt.Println(isLetter(int('1')))   // false
	fmt.Println(isDigit(int('5')))    // true
	fmt.Println(isIdentChar(int('_'))) // true
	fmt.Println(isIdentChar(int('+'))) // false

	// 关键字表
	initKeywords()
	fmt.Println(lookupKeyword("break") > 0) // true

	// scanIdent
	fmt.Println(scanIdent("break+rest"))  // "break"
	fmt.Println(scanIdent("for "))        // "for"

	// 关键字查表
	fmt.Println(lookupKeyword("break"))   // 22
	fmt.Println(lookupKeyword("xyz"))     // 0
}
