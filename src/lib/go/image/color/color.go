// src/lib/go/image/color/color.go —— `image/color` 的**子集**（pt 用到的那两格）。
//
// pt 只用三个名字：`color.RGBA`（`Color.RGBA()` 的返回）、`color.RGBA64`
// （`Color.RGBA64()` 的返回，PNG 那条路要它）、`color.Color`（`NewColor` 的形参）。
//
// **`Color` 这个名字这一份里故意不声明。** `--pkgs` 那条路把依赖包摊进**同一个平名字空间**
// （见 `src/core/graph/run.js` 的 byPkg 那一段），而 pt 自己就有一格 `type Color struct`
// —— 两个同名类型会在 `STRUCTS` / `IFACES` 里互相盖。`image` 那一份里 `Image.At` 的返回
// 因此写的是具体类型 `color.RGBA64` 而不是 go 原文的 `color.Color`（记在那一份的注里）。

package color

// RGBA 是 8 位一通道、已预乘 alpha 的颜色。
type RGBA struct {
	R, G, B, A uint8
}

// RGBA64 是 16 位一通道、已预乘 alpha 的颜色。
type RGBA64 struct {
	R, G, B, A uint16
}
