//omni:pkgs src/lib/go/image/color
// **包限定的类型名**那三格（`color.RGBA64`）。真 go 的 `image/color` 里 `RGBA64` 的字段
// 就是 `R, G, B, A uint16`，我们那份桩逐字相同，所以这一串数与 `go run` 逐字节可比。
//
// 钉住的是 pt 整包撞出来的三处"答案静默地错"：
//  1. 形参写 `c color.RGBA64` 时拿不到声明类型 ⇒ 推成 int ⇒ `c.R` 报"说不清形状"；
//  2. 那格形参的**零值**（`pzero`）走跨包表，而 `--pkgs` 是平名字空间 ⇒ 查不着；
//  3. **字面量** `color.RGBA64{…}`：`tname` 底下有两格名字，只取头一格拿到的是**包名**，
//     于是它掉进"切片字面量"那一支落成 `(arr int)` —— 图落得出来，形参对不上才炸。
package main

import "image/color"

// 形参是包限定的具名类型：三格里的第 1、2 格。
func lum(c color.RGBA64) int {
	return (int(c.R)*299 + int(c.G)*587 + int(c.B)*114) / 1000
}

// 返回也是它（`rzero` 那一侧走同一条路）。
func gray(v uint16) color.RGBA64 {
	return color.RGBA64{v, v, v, 65535}
}

// 装在记录的字段里（字段类型也是包限定的）。
type Px struct {
	C color.RGBA64
	N int
}

func main() {
	// 第 3 格：字面量。
	a := color.RGBA64{1000, 2000, 3000, 65535}
	println(lum(a))
	println(int(a.A))

	b := gray(40000)
	println(lum(b))
	println(int(b.G))

	p := Px{color.RGBA64{65535, 0, 0, 65535}, 7}
	println(lum(p.C))
	println(p.N)

	// 零值那一格（字段没写到 ⇒ 走 pzero / structZero 那条路）。
	var z Px
	println(lum(z.C))
	println(int(z.C.A))

	// 一整排，顺手压一下"形参在循环里"。
	sum := 0
	for i := 0; i < 5; i++ {
		sum += lum(gray(uint16(i * 10000)))
	}
	println(sum)
}
