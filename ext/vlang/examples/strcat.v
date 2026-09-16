// ext/vlang/examples/strcat.v —— 与 lua / go / nim 那三份 strcat **同一件事**
//
// 期望输出逐行相同：ab / hi there。
// V 与 go 一样用 `+` 接串 —— 四门语言到这儿有四种写法（`..` / `&` / `+` / `+`），
// 落到的是同一格内建。这一族因此是"写法归语言、格子归节点"最省事的一个例子：
// 一行新节点都没有加。

fn main() {
	println("a" + "b")
	s := "hi"
	println(s + " " + "there")
}
