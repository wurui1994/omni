// **两格结构体值之间的 `==` / `!=`**（pt 的 `Triangle.FixNormals` 里 `t.N1 == zero`）。
//
// go 的 struct `==` 是**逐字段比**，而方言的 `==` 对记录是**句柄比较**（asy 的 `alias`）——
// 照原样落出去 `Vector{0,0,0} == Vector{}` 会答 false（答案静默地错），而 pt 那一句正靠它
// 判"这个法向量还没填"。后端那一层看不见"这两格是不是同一个具名类型"，所以这一刀落在前端：
// 一个类型造一份 `__eq_T(a, b)`，`a == b` 落成一次调用（`ensureStructEqFn`）。
//
// 钉住的几格：嵌套的结构体字段递归比（`Rec.V` / `Rec.In`）、具名标量字段（`Kind`）、
// **指针字段按地址比**（go 的规矩 —— 两格内容相同的 `*Node` 不相等）、`!=`、
// 以及从**另一个函数体里**调它（`Rec.Same`：形参的类型只能靠 `pzero`）。
package main

type Inner struct {
	A int
	S string
}

type Vector struct{ X, Y, Z float64 }

type Kind uint8

type Node struct{ N int }

type Rec struct {
	V    Vector
	In   Inner
	K    Kind
	P    *Node
	Flag bool
}

func (r Rec) Same(o Rec) bool { return r == o }

func main() {
	zero := Vector{}
	println(Vector{0, 0, 0} == zero)
	println(Vector{1, 0, 0} == zero)
	println(Vector{1, 2, 3} != zero)

	n := &Node{7}
	m := &Node{7}
	a := Rec{Vector{1, 2, 3}, Inner{4, "x"}, 2, n, true}
	b := Rec{Vector{1, 2, 3}, Inner{4, "x"}, 2, n, true}
	println(a == b)
	println(a.Same(b))
	// 嵌套结构体的一格差
	println(a == Rec{Vector{1, 2, 9}, Inner{4, "x"}, 2, n, true})
	println(a == Rec{Vector{1, 2, 3}, Inner{5, "x"}, 2, n, true})
	println(a == Rec{Vector{1, 2, 3}, Inner{4, "y"}, 2, n, true})
	// 具名标量、指针（按地址）、bool
	println(a == Rec{Vector{1, 2, 3}, Inner{4, "x"}, 3, n, true})
	println(a == Rec{Vector{1, 2, 3}, Inner{4, "x"}, 2, m, true})
	println(a == Rec{Vector{1, 2, 3}, Inner{4, "x"}, 2, n, false})
	println(a != b)
}
