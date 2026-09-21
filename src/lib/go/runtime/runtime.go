// src/lib/go/runtime/runtime.go —— `runtime` 的**子集**（pt 用到的那两格）。
//
// `GOMAXPROCS(n)` 在这条腿上**不改任何事**：M 的个数由 `src/runtime-sched` 那个调度器
// 在 `omni_sched_init(0)` 那一句里定（0 = 按核数）。go 的语义是"设 P 的个数并回旧值"，
// 这儿回的是核数 —— pt 只拿它当"把核数说出来"用（`runtime.GOMAXPROCS(ncpu)`）。

package runtime

import "omnihost"

// NumCPU 是在线的核数。
func NumCPU() int { return int(omnihost.NumCPU()) }

// GOMAXPROCS 回核数（**不改任何事**，见文件头）。
func GOMAXPROCS(n int) int { return int(omnihost.NumCPU()) }
