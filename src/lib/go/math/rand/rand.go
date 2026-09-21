// src/lib/go/math/rand/rand.go —— `math/rand` 的**子集**，照 go 源码抄。
//
// 为什么不直接 `--pkgs $GOROOT/src/math/rand`（试过，卡在这一格）：go 1.2x 的 `rand.go` 里
// 全局那一套是 `atomic.Pointer[Rand]` + `sync.OnceValue`（泛型 + 原子指针），而 pt 一格都
// 用不到 —— 它走的是 `rand.New(rand.NewSource(seed))` 加方法。所以这一份**只留 `*Rand`
// 那一半**，把全局 RNG / lockedSource / 泛型那些去掉。
//
// **数出来的数与 `go run` 逐位相同**：决定数值的是 `rng.go`（Additive Lagged Fibonacci
// 加那张 607 格的 cooked 表）与 `normal.go`（ziggurat），这两份是从 $GOROOT **原样拷来的**，
// 一个字都没动。这一份里的 `Int63`/`Intn`/`Float64`/`Int31n` 也是照 `rand.go` 抄的同一段。
//
// 缺的那些（`Perm`/`Shuffle`/`Read`/`Zipf`/包级函数）用到了再补 —— 现在一格都没人叫。

package rand

// A Source represents a source of uniformly-distributed
// pseudo-random int64 values in the range [0, 1<<63).
type Source interface {
	Int63() int64
	Seed(seed int64)
}

// NewSource returns a new pseudo-random Source seeded with the given value.
func NewSource(seed int64) Source {
	// go 的原文是 `rng := new(rngSource)`；这儿写等价的 `&rngSource{}` ——
	// `new(T)` 那一格前端还没接（落出来是"空字典 'rng' 的键值类型推不出来"）。
	rng := &rngSource{}
	rng.Seed(seed)
	return rng
}

// A Rand is a source of random numbers.
type Rand struct {
	src Source
}

// New returns a new Rand that uses random values from src.
func New(src Source) *Rand {
	return &Rand{src: src}
}

// Seed uses the provided seed value to initialize the generator to a deterministic state.
func (r *Rand) Seed(seed int64) {
	r.src.Seed(seed)
}

// Int63 returns a non-negative pseudo-random 63-bit integer as an int64.
func (r *Rand) Int63() int64 { return r.src.Int63() }

// Uint32 returns a pseudo-random 32-bit value as a uint32.
func (r *Rand) Uint32() uint32 { return uint32(r.Int63() >> 31) }

// Int31 returns a non-negative pseudo-random 31-bit integer as an int32.
func (r *Rand) Int31() int32 { return int32(r.Int63() >> 32) }

// Int returns a non-negative pseudo-random int.
func (r *Rand) Int() int {
	u := uint(r.Int63())
	return int(u << 1 >> 1) // clear sign bit if int == int32
}

// Int63n returns, as an int64, a non-negative pseudo-random number in the half-open interval [0,n).
func (r *Rand) Int63n(n int64) int64 {
	if n&(n-1) == 0 { // n is power of two, can mask
		return r.Int63() & (n - 1)
	}
	/* go 的原文是 `max := int64((1<<63) - 1 - (1<<63)%uint64(n))` —— 那儿的取模是
	   **uint64** 的，而我们这侧还没有无符号常量（`(1<<63)` 回绕成 INT64_MIN）。
	   改写成**全 int64**的等价式：令 m = 2^63-1，则 2^63 mod n == (m mod n + 1) mod n，
	   于是 max == m - (2^63 mod n)。数值与 go 完全一样。 */
	m := int64(1<<63 - 1)
	max := m - (m%n+1)%n
	v := r.Int63()
	for v > max {
		v = r.Int63()
	}
	return v % n
}

// Int31n returns, as an int32, a non-negative pseudo-random number in the half-open interval [0,n).
func (r *Rand) Int31n(n int32) int32 {
	if n&(n-1) == 0 { // n is power of two, can mask
		return r.Int31() & (n - 1)
	}
	/* 与 `Int63n` 同一条改写（见那儿的注）：全 int32、不用无符号常量。 */
	m := int32(1<<31 - 1)
	max := m - (m%n+1)%n
	v := r.Int31()
	for v > max {
		v = r.Int31()
	}
	return v % n
}

// Intn returns, as an int, a non-negative pseudo-random number in the half-open interval [0,n).
func (r *Rand) Intn(n int) int {
	if n <= 1<<31-1 {
		return int(r.Int31n(int32(n)))
	}
	return int(r.Int63n(int64(n)))
}

// Float64 returns, as a float64, a pseudo-random number in the half-open interval [0.0,1.0).
//
// **照 go 的 `rand.go` 抄**：`float64(r.Int63()) / (1 << 63)`，那个 `== 1` 的重抽是
// Go issue 6721（除出来可能正好圆到 1.0）。go 的原文用 `again:` + `goto`，这儿写等价的
// `for` —— 数值完全一样。
//
// ⚠️ 别再写成 `float64(r.Int63n(1<<53)) / (1 << 53)`：那是**另一个数列**（我第一版写错过，
// 量出来 `Float64()*1000` 是 172 而 go 是 604；两边的算术逐位相同，错的是这一格的公式）。
func (r *Rand) Float64() float64 {
	for {
		f := float64(r.Int63()) / (1 << 63)
		if f != 1 {
			return f
		}
	}
}

// Float32 returns, as a float32, a pseudo-random number in the half-open interval [0.0,1.0).
func (r *Rand) Float32() float32 {
	for {
		f := float32(r.Float64())
		if f != 1 {
			return f
		}
	}
}
