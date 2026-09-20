// 无符号那一半（任务 #80）：`>>` / `/` / `%` 与四个大小比较在 **uint64** 上与有符号
// 不是一件事（右移补零还是补符号位、商与余数的符号、比较的次序）。
//
// 图上只有一格整数、也只有一族算符 —— 补码下 `+ - * & | ^ << == !=` 两种读法算出来的位
// 一模一样，所以只有那七个要分开。落法是 `prim` 上的一位 `uns`（有类型覆盖层那一路，
// 见 src/core/graph/nodes.js 上 prim 的注），方言那侧发 `u>>` / `u/` / `u%` / `u<` 一族。
//
// 四处来源都在这一份里：`var u uint64`（声明）、`h.s`（结构体字段，靠接收者的具名类型
// 去 STRUCTS 里查）、形参、`uint64(…)` 转换。
package main

type H struct{ s uint64 }

func (h *H) step() uint64 {
	h.s = h.s*6364136223846793005 + 1442695040888963407
	return h.s >> 33
}

func main() {
	var u uint64 = 1
	u = u << 63 // 最高位置上 —— 有符号读法下它是负数
	println(int64(u >> 11))
	println(int64(u / 3))
	println(int64(u % 7))
	if u > 5 {
		println(1)
	} else {
		println(0)
	}
	h := H{12345}
	for i := 0; i < 4; i++ {
		println(int64(h.step()))
	}
}
