// ext/vlang/examples/charlit.v —— **字符字面量落一格单字符的串**（V 独一份）
//
// 期望输出：true / false / x / vowel / other。
//
// 图上没有 char 那一格，而这一格是**语料量出来的**：V 自己的编译器里
// `` c == `e` `` 有 508 处、`` c + `0` ``（把字符当数算）只有 4 处 —— 99.2% 是
// "比较两个字符"。落成单字符的串，比较就对了，`println` 印出来也与 V 一样（印那个字符）。
//
// **两端的 backtick 要去掉**：记号里带着它们（`leaf` 拿到的是三个字符），不去掉就成了
// 三字符的串 —— 与真的单字符串一律不等。头一版正是漏了这一步，`println(`x`)` 印出了
// `` `x` ``；探针一比才看出来。
//
// **剩下那 4 处算术照旧在墙上**：`` c - `0` `` 要"把字符当数"（`ord()` 那一格），
// 落成串减串在 js 那侧是 NaN、在方言那侧当场报 —— 那要类型层，不在这一刀。
// V 的 `s[i]`（按字节取）也仍旧在墙上：图上的 `index-get` 只认列表。

module main

fn kind(c string) string {
	return match c {
		`a`, `e`, `i`, `o`, `u` { 'vowel' }
		else { 'other' }
	}
}

fn main() {
	println(`h` == `h`)
	println(`a` == `b`)
	println(`x`)
	println(kind(`e`))
	println(kind(`z`))
}
