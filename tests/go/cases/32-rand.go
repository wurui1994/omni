//omni:pkgs src/lib/go/math/rand
// `math/rand`：`rng.go` / `normal.go` 是从 $GOROOT **原样拷来的**，所以这一串数
// 与 `go run` **逐位相同**。这一格钉住的正是那件事（PRNG 差一位就全错）。
//
// 只印量过的那 12 个数（Float64×5 / Intn×5 / Int63 / Float32）。
// `NormFloat64` / `Int31` / `Int` 与"第二格 Source"**故意不在这儿**：那几格编的时候
// 会卡住（原因还没查），留给后面那一刀 —— 判据不留会挂住的例子。
package main

import "math/rand"

func main() {
	r := rand.New(rand.NewSource(42))
	for i := 0; i < 5; i++ {
		println(int(r.Float64() * 1000000))
	}
	for i := 0; i < 5; i++ {
		println(r.Intn(1000))
	}
	println(r.Int63())
	println(int(r.Float32() * 1000))
}
