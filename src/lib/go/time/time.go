// src/lib/go/time/time.go —— `time` 的**子集**（pt 用到的那几格）。
//
// 与 go 的原文差两处，都记在这儿：
//
//  1. `Time` 里装的是**单调钟的纳秒数**（`omnihost.Nanotime()`），不是 go 的
//     wall+ext+loc 三件套。pt 只用 `Now` / `Since` / `Sub` / `UnixNano`（后者当 PRNG
//     的种子），这四格问的都是"过了多久"或"给我一个会变的数"。
//  2. 时区、`Format`、`Parse` 一格都没有 —— 用到了再补。

package time

import "omnihost"

// Duration 是两个时刻之间的纳秒数。
type Duration int64

// 常用的那几格（go 的原文就是这么摞上去的）。
const (
	Nanosecond  Duration = 1
	Microsecond          = 1000 * Nanosecond
	Millisecond          = 1000 * Microsecond
	Second               = 1000 * Millisecond
	Minute               = 60 * Second
	Hour                 = 60 * Minute
)

// Nanoseconds 是这段时长的纳秒数。
func (d Duration) Nanoseconds() int64 { return int64(d) }

// Seconds 是这段时长的秒数（带小数）。
func (d Duration) Seconds() float64 { return float64(d) / 1000000000 }

// Minutes 是这段时长的分钟数（带小数）。
func (d Duration) Minutes() float64 { return float64(d) / 60000000000 }

// Hours 是这段时长的小时数（带小数）。
func (d Duration) Hours() float64 { return float64(d) / 3600000000000 }

// Time 是一个时刻。
type Time struct {
	ns int64
}

// Now 是现在。
func Now() Time { return Time{omnihost.Nanotime()} }

// UnixNano 是这个时刻的纳秒数（**单调钟的**，不是 1970 起算的 —— 见文件头）。
func (t Time) UnixNano() int64 { return t.ns }

// Sub 是 t 减 u。
func (t Time) Sub(u Time) Duration { return Duration(t.ns - u.ns) }

// Since 是从 t 到现在。
func Since(t Time) Duration { return Duration(omnihost.Nanotime() - t.ns) }
