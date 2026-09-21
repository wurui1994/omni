// **接口之间的 `==` / `!=`**（pt 的 `hit.Shape != light`）。
//
// go 里两格接口值相等 = "动态类型相同 **且** 数据指针指的是同一格"（对指针接收者那一族）。
// ADR-0040 的接口值是一格方法闭包的记录（句柄），所以接口 `==` 变成句柄比较 ——
// 而 `__box_T__I(x)` 从前每调一次造一格新记录，同一个接收者装出来的两格箱子句柄不同，
// 于是 `hit.Shape != light` 恒为真（答案静默地错）。
//
// 这一刀用**装箱记忆**解：给每个指针接收者的结构体加一格隐藏字段 `__boxof_接口名`，
// 装箱函数先看它、没有再造，于是同一个接收者永远交回**同一格箱子** ——
// 句柄比较就是 go 的指针语义。
package main

type Shape interface{ Area() int }

type Sq struct{ S int }
type Re struct{ W, H int }

func (s *Sq) Area() int { return s.S * s.S }
func (r *Re) Area() int { return r.W * r.H }

type Hit struct {
	Shape Shape
	T     int
}

func main() {
	sq := &Sq{3}
	// 两次装箱同一个接收者 → 同一格箱子 → ==
	var a Shape = sq
	var b Shape = sq
	println(a == b) // true

	// 不同的接收者 → 不同的箱子 → !=
	var c Shape = &Sq{3}
	println(a == c) // false

	// 不同的具体类型 → 一定不等
	var d Shape = &Re{2, 2}
	println(a == d) // false

	// 经过结构体字段再出来的那一格：句柄仍旧是记忆过的那一格
	h := Hit{sq, 1}
	println(h.Shape == a) // true
	println(h.Shape != a) // false

	// nil
	var nilS Shape
	println(nilS == nil) // true
	println(a == nil)    // false
	println(nilS == nilS) // true
	println(nilS != a)    // true
}
