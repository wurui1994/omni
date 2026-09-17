// ext/vlang/examples/fnval.v —— **匿名函数当值用**（与 go 那一份同一族，同一格 `func`）
//
// 期望输出：42 / 15 / 9。
//
// V 与 go 差的只有写法（`fn (x int) int { … }`）—— 落到的还是那格现成的 `func`。
//
// **带捕获表的那一种当场报**（`fn [a] (x int) { … }`，语料里 82 份）：V 的 `[a]` 是
// **按值抄一份**，而图上的闭包按引用看外层那一格 —— 外层那个名字后来改了，两者的答案就
// 不一样。要接得先有"创建时抄一份"那一刀（一格新绑定 + 体里改名），不在这一刀里。

module main

fn apply(f fn (int) int, v int) int {
	return f(v)
}

fn main() {
	inc := fn (x int) int {
		return x + 1
	}
	println(inc(41))
	println(apply(fn (x int) int {
		return x * 3
	}, 5))
	add := fn (a int, b int) int {
		return a + b
	}
	println(add(4, 5))
}
