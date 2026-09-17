// ext/vlang/examples/optres.v —— **Option / Result 落成"有没有值 + 一支垫底"**（V 独一份）
//
// 期望输出：6 / 7 / 5 / 4 / 10。
//
// 这一格是账上第二大的一族（`or-block` 190 份是 V 那一栏最高的一堵墙）。落地的口径只有
// 一句话：**这一层没有类型，Option / Result 那格值只剩"有没有"**（`if-bind` 那一格早就是
// 这个口径：`!= nil`）。于是四种写法各落一串现成的节点，图上一格新节点也没加：
//
//   * `x := f() or { 垫底 }` -> `bind x = f()` · `if x == nil { set x = 垫底 }`；
//   * `x := f() or { panic('…') }` -> 那一支以 `panic` 收尾就照原样放（`panic` 落**那格
//     assert**：条件恒假 + 消息 —— 图上"印一句话再停下来"只有那一格）；
//   * `x := f()!` / `f()?` -> `bind x = f()` · `if x == nil { return x }`
//     （"没有值"原样传上去 —— 这一批的错误值就是"没有"）；
//   * `f() or { … }` 单独一条语句 -> 一格临时名，**那一支的值不要**（要了就把一格 print
//     塞进值位置，wat 当场报）。
//
// `return none` 落 nil、`return error('…')` 也落 **nil** —— 消息不在图上。所以
// **`or { … }` 的体里一用 `err` 就当场报**：补个 nil 上去印出来是静默的错答案。
// 这一族出现在表达式里头（`g(f() or { 0 })`）也当场报：那要临时量那一刀。

module main

fn find(k int) ?int {
	if k > 0 {
		return k * 2
	}
	return none
}

fn get(k int) !int {
	if k > 0 {
		return k + 1
	}
	return error('no')
}

fn main() {
	a := find(3) or { 0 }
	println(a)
	b := find(-1) or { 7 }
	println(b)
	c := get(4)!
	println(c)
	d := find(2) or { panic('unreachable') }
	println(d)
	if e := find(5) {
		println(e)
	}
	// 有值 ⇒ 那一支不跑（这一行什么都不印）
	find(1) or { println('nope') }
}
