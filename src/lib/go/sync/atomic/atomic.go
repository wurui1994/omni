// src/lib/go/sync/atomic/atomic.go —— `sync/atomic` 的**子集**：只有 `Load*`。
//
// **两件事都没有，所以只给读**：
//  1. **不是真原子的**：原子性在图那一层压根没有形式（方言里没有 `atomic` 那一族节点，
//     要加就得动 prims.js 与六条后端 —— 任务 #76 记着）。这一份的读落成一次普通的读。
//  2. **写那一半给不出来**：`AddUint64(addr *uint64, …)` 的体是 `*addr = *addr + delta`，
//     而我们这条腿上**没有"指向标量的指针"这一格** —— `&s.rays` 递过去的是那一格的**值**，
//     写不回调用者。硬写出来是"答案静默地错"（计数器永远停在 0），所以这一份**干脆不提供**：
//     调用点会撞上一句有名有姓的墙（`这一层里没有 AddUint64`）。
//
// pt 的 `Scene.rays` 就在后一档上（`atomic.AddUint64(&s.rays, 1)`）—— `bench/go/ptcore.mjs`
// 把那一句剪掉了（它只喂进度条，而进度条那几句本来就被剪掉了），理由写在那儿。

package atomic

// LoadUint64 读一格 uint64（不是真原子的，见文件头）。
func LoadUint64(addr *uint64) uint64 { return *addr }

// LoadInt64 同上，有符号那一半。
func LoadInt64(addr *int64) int64 { return *addr }
