// src/lib/go/sync/atomic/atomic.go —— `sync/atomic` 的**子集**（pt 用到的那两格）。
//
// **这一份不是真原子的**：它落成一次普通的读 / 加。为什么可以这样：
//   * 我们这条腿的 `.go` 前端把 `go f()` 落到 `omni_sched`（ADR-0038），而**原子性**在
//     图那一层压根没有形式 —— 方言里没有 `atomic` 那一族节点（要加就得动 prims.js 与六条
//     后端，那是另一刀，任务 #76 记着）；
//   * pt 只拿它数射线（`Scene.rays`），那个数**不参与出图**：少数几次丢更新只会让
//     "每秒多少条射线"这一行报得偏小，像素一个都不差。
//
// 所以这一份是**给单线程那一档用的**：`omni build` 出来的 pt 渲染核心跑单 goroutine 时
// 它与 go 逐字节相同。**多 goroutine 那一档别拿它当尺子** —— 那时这个计数是"大约"。
// 真原子要等 C 前端补上 `stdatomic.h`（任务 #76），那时这一份换成 ccall 就行。

package atomic

// LoadUint64 读一格 uint64（这一份不是真原子的，见文件头）。
func LoadUint64(addr *uint64) uint64 { return *addr }

// AddUint64 往一格 uint64 上加（这一份不是真原子的，见文件头）。回加完之后的值。
func AddUint64(addr *uint64, delta uint64) uint64 {
	*addr = *addr + delta
	return *addr
}

// LoadInt64 / AddInt64：同上，有符号那一半。
func LoadInt64(addr *int64) int64 { return *addr }

func AddInt64(addr *int64, delta int64) int64 {
	*addr = *addr + delta
	return *addr
}

// StoreUint64 / StoreInt64：写一格（这一份不是真原子的，见文件头）。
func StoreUint64(addr *uint64, val uint64) { *addr = val }

func StoreInt64(addr *int64, val int64) { *addr = val }
