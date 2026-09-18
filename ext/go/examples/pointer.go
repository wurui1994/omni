// ext/go/examples/pointer.go —— **`&T{…}` 与图上的引用正好重合**
//
// 期望输出：11 / 20 / 5 / 20。
//
// 图上没有指针那一格，这一份判的是**为什么不需要**：`record-new` 交出来的是一格对象，
// 两个名字绑上去指的是同一格（`eval.js` 那一格是普通的 JS 对象）—— 所以
// `p := &Node{…}` 之后 `p.val = 1` 改的就是那一格，与 go 一模一样。**不是近似，是重合。**
//
// 三处写法这一份都压着：
//   * `&T{…}` 当值传给函数 —— 里头改了外头看得见（`bump`）；
//   * 两个名字指同一格（`q := p` 之后改 q，p 跟着变）；
//   * `(*p).f` —— 那一层 deref **剥掉**（`unwrapDeref`）。
//
// **`&x` 里 x 已经是一格 struct 的那一半后来也接上了**（末两行判着）：图上的记录就是引用，
// 所以 `s := &r` 之后 `s.val = 9` 改的就是 r 那一格 —— 与 `&T{…}` 逐字同理。
// 靠的是"x 的具名类型写在语法上"（`r := Node{…}`）+ 那个类型登记过是 struct。
//
// 反过来仍旧**当场报**：`&x` 里 x 是标量或类型没写在语法上、以及光秃秃的 `*p` 当值用。
// 那两处要真的指针：一个是"两处名字指同一格标量"，一个是"换掉被指的那一整格"。

package main

import "fmt"

type Node struct {
	val   int
	other int
}

func bump(p *Node) {
	p.val = p.val + 1
}

func main() {
	p := &Node{val: 10, other: 5}
	bump(p)
	fmt.Println(p.val)
	q := p
	q.val = 20
	fmt.Println(p.val)
	fmt.Println(p.other)
	fmt.Println((*q).val)
	r := Node{val: 7, other: 1}
	s := &r
	s.val = 9
	fmt.Println(r.val)
}
