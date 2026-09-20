// **数组当结构体字段**（`Mesh.Triangles []Tri` 那一族 —— pt 的 `Mesh` / `Buffer.Pixels`）。
//
// 从前这一格**不报缺口、却给了错类型**：`backend-core.js` 的 `bindRecord` 对字段值只分三档
// （另一格记录 / 一格函数值 / 标量），`list-new` 掉到最后一档而 `typeOf(list-new)` 回的是
// UNKNOWN=`int`，于是静静通过了"是不是标量"那道闸 —— 随后 `range` 出来的元素就是 int，
// 一取字段报"在一格说不清形状的东西上取字段 'V1'"。
//
// 三件事一起钉：字段的类型是 `(arr rN)`、`make` 写进字段（表达式位置上落不下去，要物化）、
// `len(结构体的那格字段)` 要发 `alen` 而不是 `slen`。
package main

import "fmt"

type Tri struct {
	V1 float64
	V2 float64
}

type Mesh struct {
	Triangles []Tri
	Name      string
}

func (m *Mesh) SumV1() float64 {
	t := 0.0
	for _, tr := range m.Triangles {
		t += tr.V1
	}
	return t
}

func main() {
	m := Mesh{}
	m.Name = "m"
	m.Triangles = make([]Tri, 2)
	m.Triangles[0] = Tri{1, 2}
	m.Triangles[1] = Tri{10, 20}
	fmt.Println(m.SumV1())
	fmt.Println(len(m.Triangles))
	fmt.Println(m.Name)
}
