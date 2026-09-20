// **接口方法返回接口自己**（`Pow(float64) Texture`）—— pt 的 `Texture` 就是这个形状。
//
// 两格账（都是这一刀之前当场炸的）：
//  1. 零值记录的字段类型里提到它**自己**，形状的标签得先有名字才说得出字段类型 ——
//     不动点（`backend-core.js` 的 `SELF_TY`）；
//  2. 那一格桩的体得**交回一格这个接口的零值**，就地再铺一份是无限深的节点树 ——
//     所以走一格顶层的 `__nilof_接口名()`。
//
// 加上"接口当结构体字段"（`Material.Tex`）与"整格接口值写进字段"（`m.Tex = &…`，
// 方言里整块写还没做，要逐字段抄）。
package main

import "fmt"

type Texture interface {
	Sample(u, v float64) float64
	Pow(a float64) Texture
}

type ColorTexture struct {
	c float64
}

func (t *ColorTexture) Sample(u, v float64) float64 { return t.c }
func (t *ColorTexture) Pow(a float64) Texture       { return &ColorTexture{t.c * a} }

type Material struct {
	Tex   Texture
	Bump  Texture
	Gloss float64
}

type Tri struct {
	V1  float64
	Mat *Material
}

func (t *Tri) SumX() float64 { return t.V1 + t.Mat.Gloss }

func main() {
	var m Material
	m.Gloss = 4
	m.Tex = &ColorTexture{2}
	tr := &Tri{3, &m}
	fmt.Println(tr.SumX())
	fmt.Println(m.Tex.Sample(0, 0))
	fmt.Println(m.Tex.Pow(3).Sample(0, 0))
}
