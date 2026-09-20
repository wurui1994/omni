// `math.*` —— go 前端从前**根本没有 math 的映射**：`math` 只有一格常量桩，函数落到
// "取字段再调它"的兜底上，core 报"记录 rN 上没有字段 'Max'（它有的是：MaxInt32 …）"。
//
// 现在三条路：
//   * 方言的 `(rmath "f" …)` 里有的（sqrt/fabs/floor/ceil/pow/sin/cos/tan/atan2/log/hypot…）
//     落 `call __goMath_f(…)`，`backend-core.js` 的 `GO_RMATH` 认名字发 rmath；
//   * `Max`/`Min` 没有对应的 rmath —— 生成一格 go 级辅助函数（不用 branch：那会把实参
//     复制一遍，`math.Max(f(), g())` 于是四次调用）；
//   * `Modf` 在**语句**那一层落（往零截断要拐一下 floor），`Pi`/`E` 是常量桩。
//
// `math.MaxFloat64` 顺带钉住一格：`Number.isInteger(1.79e308)` 在 JS 里为真，
// 所以 `litType` 的界得是 **2^63**（int64）而不是 `isSafeInteger` 的 2^53 ——
// 后者会把 `6364136223846793005`（见 10-unsigned.go）说成 real。
package main

import "math"

func main() {
	println(int(math.Sqrt(2.0) * 1000000.0))
	println(int(math.Abs(-3.5) * 10.0))
	println(int(math.Floor(2.7)))
	println(int(math.Ceil(2.1)))
	println(int(math.Pow(2.0, 10.0)))
	println(int(math.Max(3.0, 7.0)))
	println(int(math.Min(3.0, 7.0)))
	p := math.Pi
	println(int(p * 1000000.0))
	println(int(math.Atan2(1.0, 1.0) * 1000000.0))
	println(int(math.Hypot(3.0, 4.0)))
	i, f := math.Modf(3.75)
	println(int(i))
	println(int(f * 100.0))
	j, g := math.Modf(-3.75)
	println(int(j))
	println(int(g * 100.0))
}
