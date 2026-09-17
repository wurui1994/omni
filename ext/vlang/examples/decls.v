// ext/vlang/examples/decls.v —— **顶层那几格声明与修饰**（V 独一份的家族）
//
// 期望输出：25 / 20 / 1。
//
// 单开一个家族的理由与 go 的 `vardecl.go` 同一条：**一格新节点都没加** ——
// 这一族全是"落成 bind"或"整格丢掉"，而判"该丢还是该拆"只有这门语言说得清：
//   * `pub` 是**可见性**、`@[inline]` 是**属性表** —— 两样都不产生代码，拆一层接着走
//     （与 `mut` 同一类：`ext/vlang/SPEC.md` §四第 2 条那一条）；
//   * `const a = 1` 与 `const ( … )` -> 一串 bind。V 这一格比 go 干净：语法里就写着
//     `IDENT "=" expr`，**没有** go 那两条规矩（省略初值重复上一条、`iota`）；
//   * `type MyInt = int`（别名 / sumtype）与 `interface` 都是**类型的声明** ——
//     类型不进图，整格丢掉；
//   * `true` / `false` 在 V 的语法里是自己一条产生式（`(bool …)`），不是名字。

module main

type MyInt = int

interface Shape {
	area() int
}

pub struct Point {
	x int
}

pub const start = 10

const (
	step  = 5
	limit = 3
)

@[inline]
pub fn twice(n int) int {
	return n * 2
}

fn main() {
	mut acc := start
	for i := 0; i < limit; i++ {
		acc = acc + step
	}
	println(acc)
	println(twice(start))
	ok := true
	if ok {
		println(1)
	} else {
		println(0)
	}
}
