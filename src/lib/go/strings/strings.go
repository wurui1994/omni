// src/lib/go/strings/strings.go —— `strings` 的**子集**（pt 用到的那几格 + 写别的桩要的）。
//
// **全是纯 go**：串上要的三件事（长度、子串、比较）方言那一层本来就有
// （`(slen …)` / `(ssub …)` / `(bin "==" …)`），所以这一份不碰宿主。
//
// `Index` 写成"逐位置比子串"而不是落方言的 `(sfind …)`：图那一层还没有"找子串"这格
// 节点，而加一格 prim 要动六条腿。这一份是 O(n·m) 的朴素做法 —— pt 里最长的调用是
// `strings.Contains(path, "%")`（m = 1），不值得为它加节点。

package strings

// Index 是 sub 在 s 里第一次出现的下标；没有回 -1。
func Index(s string, sub string) int {
	n := len(sub)
	if n == 0 {
		return 0
	}
	if n > len(s) {
		return -1
	}
	last := len(s) - n
	for i := 0; i <= last; i++ {
		if s[i:i+n] == sub {
			return i
		}
	}
	return -1
}

// Contains 问 sub 在不在 s 里。
func Contains(s string, sub string) bool { return Index(s, sub) >= 0 }

// HasPrefix 问 s 是不是以 p 开头。
func HasPrefix(s string, p string) bool {
	return len(s) >= len(p) && s[0:len(p)] == p
}

// HasSuffix 问 s 是不是以 p 结尾。
func HasSuffix(s string, p string) bool {
	return len(s) >= len(p) && s[len(s)-len(p):len(s)] == p
}

// isSpace 照 `unicode.IsSpace` 的 ASCII 那一半（`Fields` 只要这几格）。
func isSpace(c string) bool {
	return c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\v" || c == "\f"
}

// Fields 按空白切开，**空的那几段不要**（go 的语义）。
func Fields(s string) []string {
	out := []string{}
	start := -1
	for i := 0; i < len(s); i++ {
		if isSpace(s[i : i+1]) {
			if start >= 0 {
				out = append(out, s[start:i])
				start = -1
			}
		} else if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		out = append(out, s[start:len(s)])
	}
	return out
}

// Split 按 sep 切开，**空的那几段也要**（go 的语义）。sep 是空串时逐字节切。
func Split(s string, sep string) []string {
	out := []string{}
	if len(sep) == 0 {
		for i := 0; i < len(s); i++ {
			out = append(out, s[i:i+1])
		}
		return out
	}
	start := 0
	i := 0
	for i+len(sep) <= len(s) {
		if s[i:i+len(sep)] == sep {
			out = append(out, s[start:i])
			i += len(sep)
			start = i
		} else {
			i++
		}
	}
	out = append(out, s[start:len(s)])
	return out
}

// Join 把那几段接起来，中间垫 sep。
func Join(a []string, sep string) string {
	out := ""
	for i := 0; i < len(a); i++ {
		if i > 0 {
			out += sep
		}
		out += a[i]
	}
	return out
}

// TrimSpace 去掉两头的空白。
//
// 两圈都写成"条件只有一格比较、里头 break"而不是 `for i < len(s) && isSpace(…)` ——
// **`&&` 在 while 的条件里这条腿还没接**（`&&` 落成一格表达式位置的 branch，而那要物化，
// 提到循环外就不是每轮算了，core 那侧当场报）。语义完全一样。
func TrimSpace(s string) string {
	i := 0
	for i < len(s) {
		if !isSpace(s[i : i+1]) {
			break
		}
		i++
	}
	j := len(s)
	for j > i {
		if !isSpace(s[j-1 : j]) {
			break
		}
		j--
	}
	return s[i:j]
}
