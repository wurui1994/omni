// **撞名：一格被闭包借走的局部量 vs 另一个函数里的同名局部量**（pt 的
// `Triangle.Barycentric` 的具名返回值 `w` 撞上 `Renderer.run` 里被 goroutine 借走的 `w`）。
//
// core 那侧把"被内层函数借走的局部量"落成**模块级 global**（方言的顶层函数看不见别人的
// 局部量）。可那一格是**按名字**的：另一个函数里有个同名的局部量，就会被当成对那格 global
// 的赋值 —— 两个互不相干的变量共用一格存储、还共用一格类型。
// 量出来的是 `m85.v2 是 real，写进去的是 int`（`w` 在一处是 int、在另一处是 float64）。
//
// 修法（`renameShadowedGlobals`）：一个函数**绑过**这个名字、它在这个函数里**不自由**、
// 也不是从这个函数体里提出去的闭包借的那一格 —— 那就给它换个名字（`w__loc`）。
//
// 顺带钉住第二格：**具名返回值的声明类型**要进 `VARTY` —— `u = 1` 得按 `float64` 转，
// 不然方言报 `'u' 是 real，赋的值是 int`。
package main

// 具名返回值里有 u / v / w —— 与下面被闭包借走的那三格同名
func bary(k float64) (u, v, w float64) {
	u = 1
	v = 2 * k
	w = 3
	return
}

// 这三格被内层函数借走 ⇒ core 那侧落成 global
func borrowed() int {
	w := 4
	h := 5
	add := func() int { return w + h }
	return add()
}

func main() {
	a, b, c := bary(1.5)
	println(int(a))
	println(int(b))
	println(int(c))
	println(borrowed())
	// 再来一趟：global 那一格没被 bary 写坏
	println(borrowed())
	d, e, f := bary(10)
	println(int(d))
	println(int(e))
	println(int(f))
}
