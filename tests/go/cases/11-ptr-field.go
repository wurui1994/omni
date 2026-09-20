// **指针字段那一族**：`type Outer struct{ In *Inner }`。
//
// 三格连着的账（都是这一刀之前当场炸的）：
//   1. `zeroOf` 对 `*T` 一律回 `lit(null)` ⇒ `Outer` 的零值记录里那一格说不清类型
//      ⇒ `func (o *Outer) …` 的体里 `o.In` 报"在一格说不清形状的东西上取字段"。
//      现在 `*T` 里 T 是具名结构体时，零值是**T 的零值记录**（引用语义那一档），
//      而且"被 `*T` 指过"的类型一律引用语义（`PTRED` -> `PTRRECV`）。
//   2. 字段值是一格**已经躺在名字里的记录**（`Outer{&in, 3}`）从前报"字段不是标量"——
//      现在走 `objText` 那条路（记录当宿主用），存法交给 `storeInto`。
//   3. `o.In.A` 从前落 `(pfield (pfield (var o) In) A)` —— 那一格里装的是**地址**，
//      要先 `pload` 出来才能再 `pfield`。
//
// 这一族是 pt 的 `Triangle{Material *Material, V1..V3 Vector}` 的形状。
package main

type Inner struct{ A, B float64 }

type Outer struct {
	In *Inner
	K  int
}

func (o *Outer) sum() float64 {
	return o.In.A + o.In.B + float64(o.K)
}

func main() {
	in := Inner{1.5, 2.5}
	o := Outer{&in, 3}
	println(int(o.sum() * 10.0))
	// 指针字段是**同一格** —— 改里头外头看得见
	in.A = 10.5
	println(int(o.sum() * 10.0))
}
