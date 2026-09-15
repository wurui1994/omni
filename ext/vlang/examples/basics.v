// ext/vlang/examples/basics.v —— 与 chez / lua / go / sbcl 那几份**同一件事**
//
// 输出必须逐行相同：15 / 120 / 7 / ok（判据在 tests/graph/run.js）。
// V 这一份压的是"**不可变是默认的**"：要改的量得写 `mut`。而 `mut` 是一格
// **不产生代码的检查**（ADR-0033 §7 那一类），所以映射里直接拆掉 —— 图上看不见它。
//
// 要素对照：
//   fn + 形参表          -> bind + func
//   := / mut :=          -> bind（mut 拆掉）
//   =                    -> set
//   for init; cond; post -> region + loop + set
//   if / else            -> branch
//   return               -> ret
//   println              -> prim print

fn sumto(n int) int {
	mut acc := 0
	for i := 1; i <= n; i++ {
		acc = acc + i
	}
	return acc
}

fn fact(n int) int {
	if n == 0 {
		return 1
	}
	return n * fact(n - 1)
}

fn max2(a int, b int) int {
	if a > b {
		return a
	} else {
		return b
	}
}

fn main() {
	println(sumto(5))
	println(fact(5))
	println(max2(3, 7))
	tag := "ok"
	println(tag)
}
