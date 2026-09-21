// src/lib/go/strconv/strconv.go —— `strconv` 的**子集**（pt 用到的那两格 + Itoa）。
//
// **全是纯 go**（串上那三件事方言本来就有，见 `strings` 那份的注）。字符 -> 数值不走
// "取一个字节的码"（图那一层还没有那格节点），而是 `strings.Index("0123456789", c)`
// —— 一次 10 格的朴素查找，解析的量在 pt 里是"读一次 .obj/.stl"，不在热路径上。
//
// 与 go 的差（pt 用不到，记在这儿）：
//   * 不认下划线分隔符（`1_000`）、不认 `Inf` / `NaN`、不认十六进制浮点（`0x1p-3`）；
//   * `bitSize` 一律忽略（我们这条腿只有一格 int64 / 一格 float64）；
//   * 出错时**回零值 + nil**，不回 `*NumError`（`error` 那一族在图上就是 nil）。
//     pt 两处都写的是 `f, _ := strconv.ParseFloat(…)` —— 错误那一格本来就丢掉。

package strconv

import "strings"

const digits10 = "0123456789"
const digits36 = "0123456789abcdefghijklmnopqrstuvwxyz"

// digitVal 是这一格字符在 base 进制里的值；不是数字回 -1。
func digitVal(c string, base int) int {
	v := strings.Index(digits36, c)
	if v < 0 {
		v = strings.Index("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", c)
	}
	if v < 0 || v >= base {
		return -1
	}
	return v
}

// ParseInt 按 base 读一格整数。base = 0 时看前缀（`0x` / `0b` / `0o` / `0`）。
func ParseInt(s string, base int, bitSize int) (int64, error) {
	i := 0
	neg := false
	if i < len(s) {
		c := s[i : i+1]
		if c == "-" {
			neg = true
			i++
		} else if c == "+" {
			i++
		}
	}
	b := base
	if b == 0 {
		b = 10
		if i+1 < len(s) && s[i:i+1] == "0" {
			p := s[i+1 : i+2]
			if p == "x" || p == "X" {
				b = 16
				i += 2
			} else if p == "b" || p == "B" {
				b = 2
				i += 2
			} else if p == "o" || p == "O" {
				b = 8
				i += 2
			} else {
				b = 8
				i++
			}
		}
	}
	var n int64 = 0
	any := false
	for i < len(s) {
		d := digitVal(s[i:i+1], b)
		if d < 0 {
			break
		}
		n = n*int64(b) + int64(d)
		any = true
		i++
	}
	if !any {
		return 0, nil
	}
	if neg {
		return -n, nil
	}
	return n, nil
}

// Atoi 是 `ParseInt(s, 10, 0)` 的整数版。
func Atoi(s string) (int, error) {
	n, err := ParseInt(s, 10, 0)
	return int(n), err
}

// ParseFloat 读一格十进制浮点（可带指数）。
func ParseFloat(s string, bitSize int) (float64, error) {
	i := 0
	neg := false
	if i < len(s) {
		c := s[i : i+1]
		if c == "-" {
			neg = true
			i++
		} else if c == "+" {
			i++
		}
	}
	whole := 0.0
	for i < len(s) {
		d := strings.Index(digits10, s[i:i+1])
		if d < 0 {
			break
		}
		whole = whole*10 + float64(d)
		i++
	}
	if i < len(s) {
		if s[i:i+1] == "." {
			i++
			scale := 0.1
			for i < len(s) {
				d := strings.Index(digits10, s[i:i+1])
				if d < 0 {
					break
				}
				whole += float64(d) * scale
				scale /= 10
				i++
			}
		}
	}
	/* 指数那一段：`e` / `E` 之后是一格带符号的十进制整数。 */
	if i < len(s) {
		c := s[i : i+1]
		if c == "e" || c == "E" {
			i++
			eneg := false
			if i < len(s) {
				sc := s[i : i+1]
				if sc == "-" {
					eneg = true
					i++
				} else if sc == "+" {
					i++
				}
			}
			ev := 0
			for i < len(s) {
				d := strings.Index(digits10, s[i:i+1])
				if d < 0 {
					break
				}
				ev = ev*10 + d
				i++
			}
			for k := 0; k < ev; k++ {
				if eneg {
					whole /= 10
				} else {
					whole *= 10
				}
			}
		}
	}
	if neg {
		return -whole, nil
	}
	return whole, nil
}

// Itoa 把一格整数印成十进制串。
func Itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := false
	n := i
	if n < 0 {
		neg = true
		n = -n
	}
	out := ""
	for n > 0 {
		out = digits10[n%10:n%10+1] + out
		n /= 10
	}
	if neg {
		return "-" + out
	}
	return out
}
