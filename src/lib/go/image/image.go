// src/lib/go/image/image.go —— `image` 的**子集**（pt 用到的那几格）。
//
// 三处与 go 的原文不同，都是被"`--pkgs` 摊成同一个平名字空间"逼出来的，各记在下面：
//
//  1. `Image.At` 的返回写的是 `color.RGBA64` 而不是 `color.Color` —— `color` 那一份里
//     没有 `Color`（pt 自己有一格同名的 struct，见那儿的注）。
//  2. 位图那一格叫 `Image64` 而不是 go 的 `RGBA64` —— 后者会与 `color.RGBA64` 撞名。
//     pt 一处都没写这个类型的名字（只写 `image.NewRGBA64(…)`），所以改名不影响它。
//  3. 像素存的是 `[]uint16` 而不是 go 的 `[]uint8`（大端两字节一格）—— 少一层拆装，
//     而唯一读它的人是同一族里的 `image/png`。

package image

import "image/color"

// Point 是一格整数坐标。
type Point struct {
	X, Y int
}

// Rectangle 是 [Min, Max) 那一夹（Max 不含）。
type Rectangle struct {
	Min, Max Point
}

// Pt 造一格坐标。
func Pt(x, y int) Point { return Point{x, y} }

// Rect 造一格矩形。
func Rect(x0, y0, x1, y1 int) Rectangle {
	return Rectangle{Point{x0, y0}, Point{x1, y1}}
}

// Dx 是宽。
func (r Rectangle) Dx() int { return r.Max.X - r.Min.X }

// Dy 是高。
func (r Rectangle) Dy() int { return r.Max.Y - r.Min.Y }

// Image 是"能问边界、能问某一格像素"的东西。
type Image interface {
	Bounds() Rectangle
	At(x, y int) color.RGBA64
}

// Image64 是一格 16 位四通道的位图（go 里叫 `image.RGBA64`，改名的理由见文件头）。
type Image64 struct {
	Pix    []uint16
	Stride int
	Rect   Rectangle
}

// NewRGBA64 按这一夹造一格全零的位图。
func NewRGBA64(r Rectangle) *Image64 {
	w := r.Dx()
	h := r.Dy()
	return &Image64{make([]uint16, 4*w*h), 4 * w, r}
}

// Bounds 是这格位图的那一夹。
func (p *Image64) Bounds() Rectangle { return p.Rect }

// At 读一格像素。
func (p *Image64) At(x, y int) color.RGBA64 {
	i := (y-p.Rect.Min.Y)*p.Stride + (x-p.Rect.Min.X)*4
	return color.RGBA64{p.Pix[i], p.Pix[i+1], p.Pix[i+2], p.Pix[i+3]}
}

// SetRGBA64 写一格像素。
func (p *Image64) SetRGBA64(x, y int, c color.RGBA64) {
	i := (y-p.Rect.Min.Y)*p.Stride + (x-p.Rect.Min.X)*4
	p.Pix[i] = c.R
	p.Pix[i+1] = c.G
	p.Pix[i+2] = c.B
	p.Pix[i+3] = c.A
}
