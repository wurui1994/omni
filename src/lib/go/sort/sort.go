// src/lib/go/sort/sort.go —— `sort` 的**子集**（pt 的 `Node.Split` 用 `Float64s`）。
//
// 就地的快排 + 小段插入排序，与 go 的 `sort.Float64s` **结果相同**（都是升序、
// 都不稳定 —— 一串 float64 上"稳定"没有可观察的差别）。
//
// 为什么不照 `sort.Slice`（要传函数值）：pt 只用 `Float64s`，而那一格不需要回调。
// 递归写成显式的栈也没必要 —— pt 里排的是三条轴各 2N 个数，深度是 log。

package sort

// Float64s 把一串 float64 升序就地排好。
func Float64s(a []float64) {
	quick(a, 0, len(a)-1)
}

// insertion 是小段用的插入排序（快排到短段就交给它 —— go 也是这么摞的）。
func insertion(a []float64, lo int, hi int) {
	for i := lo + 1; i <= hi; i++ {
		v := a[i]
		j := i - 1
		for j >= lo {
			if a[j] <= v {
				break
			}
			a[j+1] = a[j]
			j--
		}
		a[j+1] = v
	}
}

func quick(a []float64, lo int, hi int) {
	for hi-lo > 11 {
		/* 三点取中：首、中、尾里的中位数当轴，摆到 lo 上。 */
		mid := lo + (hi-lo)/2
		if a[mid] < a[lo] {
			a[mid], a[lo] = a[lo], a[mid]
		}
		if a[hi] < a[mid] {
			a[hi], a[mid] = a[mid], a[hi]
			if a[mid] < a[lo] {
				a[mid], a[lo] = a[lo], a[mid]
			}
		}
		a[lo], a[mid] = a[mid], a[lo]
		p := a[lo]
		i := lo + 1
		j := hi
		for i <= j {
			for i <= j {
				if a[i] >= p {
					break
				}
				i++
			}
			for i <= j {
				if a[j] <= p {
					break
				}
				j--
			}
			if i <= j {
				a[i], a[j] = a[j], a[i]
				i++
				j--
			}
		}
		a[lo], a[j] = a[j], a[lo]
		/* 短的那一半递归、长的那一半继续这一圈 —— 栈深不超过 log。 */
		if j-lo < hi-j {
			quick(a, lo, j-1)
			lo = j + 1
		} else {
			quick(a, j+1, hi)
			hi = j - 1
		}
	}
	if lo < hi {
		insertion(a, lo, hi)
	}
}
// Ints 与 `Float64s` 同一条路（写别的桩时用得上）。
func Ints(a []int) {
	for i := 1; i < len(a); i++ {
		v := a[i]
		j := i - 1
		for j >= 0 {
			if a[j] <= v {
				break
			}
			a[j+1] = a[j]
			j--
		}
		a[j+1] = v
	}
}
