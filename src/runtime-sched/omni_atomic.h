/* omni_atomic.h —— 原子操作那几个入口（**照 Go 的 `runtime/internal/atomic`**）
 *
 * 为什么不直接用 `<stdatomic.h>`：我们自己那台 C 前端还没有它，而调度器要进
 * `src/runtime/`（那个目录整份都由我们自己的前端编，见 #76）。
 *
 * **Go 自己也不用 C11 原子** —— 它是 `runtime/internal/atomic` 的一组手写汇编，
 * 入口就这么几个（`atomic_arm64.s`）：Load / Load64 / LoadAcq / Loadp /
 * Store / Store64 / StoreRel / Cas / Cas64 / Casp1 / Xadd / Xadd64。
 * 所以这一份照着那个形状给，而不是把 C11 那一整套搬进来：
 * 字段是**普通字段**（不是 `_Atomic`），要原子就显式调这几个函数 —— 与 Go 一字不差。
 *
 * 两种实现：
 *   * clang / gcc：`__atomic_*` 内建（那就是 C11 底下真正发的东西）；
 *   * 我们自己那台 C 前端：**还没有**（#76）——那时这个头会 `#error`，
 *     而不是静静地退化成非原子的读写。arm64 是弱序的，少一道 acquire/release
 *     不是"慢一点"，是**偶发的错答案**，所以这儿宁可编不过。
 *
 * 命名照 Go：`Load` 是 32 位、`Load64` 是 64 位、`Loadp` 是指针；
 * 后缀 `Acq`/`Rel` 是 acquire / release，没后缀的是 seq_cst（Go 的 Cas 也是全序）。
 */
#ifndef OMNI_ATOMIC_H
#define OMNI_ATOMIC_H

#include <stdint.h>

#if !defined(__clang__) && !defined(__GNUC__)
#error "omni_atomic.h：这台编译器还没有 __atomic_* 内建（见 #76：我们自己的 C 前端要补这几个入口）"
#endif

/* ---- 32 位（Go 的 Load / Store / Cas / Xadd，作用在 int32 / uint32 上） ---- */
static inline uint32_t omni_atomic_load32(volatile uint32_t *p) {
  return __atomic_load_n(p, __ATOMIC_SEQ_CST);
}
static inline uint32_t omni_atomic_load32_relaxed(volatile uint32_t *p) {
  return __atomic_load_n(p, __ATOMIC_RELAXED);
}
static inline uint32_t omni_atomic_load32_acq(volatile uint32_t *p) {
  return __atomic_load_n(p, __ATOMIC_ACQUIRE);
}
static inline void omni_atomic_store32(volatile uint32_t *p, uint32_t v) {
  __atomic_store_n(p, v, __ATOMIC_SEQ_CST);
}
static inline void omni_atomic_store32_rel(volatile uint32_t *p, uint32_t v) {
  __atomic_store_n(p, v, __ATOMIC_RELEASE);
}
static inline void omni_atomic_store32_relaxed(volatile uint32_t *p, uint32_t v) {
  __atomic_store_n(p, v, __ATOMIC_RELAXED);
}
/* 回 1 = 换成了。`old` 是**传值**的（Go 的 Cas 也是）—— C11 那套的"失败时回写 old"
   这一格调用方从来没用过，去掉它两边的形状才一样。 */
static inline int omni_atomic_cas32(volatile uint32_t *p, uint32_t old, uint32_t new_) {
  return __atomic_compare_exchange_n(p, &old, new_, 0,
                                     __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST) ? 1 : 0;
}
/* release / relaxed 那一对（runqput 的 tail、runqgrab 的 head 用它） */
static inline int omni_atomic_cas32_rel(volatile uint32_t *p, uint32_t old, uint32_t new_) {
  return __atomic_compare_exchange_n(p, &old, new_, 0,
                                     __ATOMIC_RELEASE, __ATOMIC_RELAXED) ? 1 : 0;
}
/* 回**加之前**的值（C 的 fetch_add 口径。Go 的 Xadd 回加之后的，调用方各自换算）。 */
static inline int32_t omni_atomic_xadd32(volatile int32_t *p, int32_t d) {
  return __atomic_fetch_add(p, d, __ATOMIC_SEQ_CST);
}
static inline int32_t omni_atomic_loadi32(volatile int32_t *p) {
  return __atomic_load_n(p, __ATOMIC_SEQ_CST);
}
static inline void omni_atomic_storei32(volatile int32_t *p, int32_t v) {
  __atomic_store_n(p, v, __ATOMIC_SEQ_CST);
}
static inline int omni_atomic_casi32(volatile int32_t *p, int32_t old, int32_t new_) {
  return __atomic_compare_exchange_n(p, &old, new_, 0,
                                     __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST) ? 1 : 0;
}

/* ---- 64 位（Go 的 Load64 / Store64 / Cas64 / Xadd64） ---- */
static inline int64_t omni_atomic_load64(volatile int64_t *p) {
  return __atomic_load_n(p, __ATOMIC_SEQ_CST);
}
static inline void omni_atomic_store64(volatile int64_t *p, int64_t v) {
  __atomic_store_n(p, v, __ATOMIC_SEQ_CST);
}
static inline int64_t omni_atomic_xadd64(volatile int64_t *p, int64_t d) {
  return __atomic_fetch_add(p, d, __ATOMIC_SEQ_CST);
}

/* ---- 指针（Go 的 Loadp / Casp1）。`void **` 收口，调用方自己转。 ---- */
static inline void *omni_atomic_loadp(void *volatile *p) {
  return __atomic_load_n(p, __ATOMIC_SEQ_CST);
}
static inline void *omni_atomic_loadp_acq(void *volatile *p) {
  return __atomic_load_n(p, __ATOMIC_ACQUIRE);
}
static inline void *omni_atomic_loadp_relaxed(void *volatile *p) {
  return __atomic_load_n(p, __ATOMIC_RELAXED);
}
static inline int omni_atomic_casp(void *volatile *p, void *old, void *new_) {
  return __atomic_compare_exchange_n(p, &old, new_, 0,
                                     __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST) ? 1 : 0;
}
static inline int omni_atomic_casp_rel(void *volatile *p, void *old, void *new_) {
  return __atomic_compare_exchange_n(p, &old, new_, 0,
                                     __ATOMIC_RELEASE, __ATOMIC_RELAXED) ? 1 : 0;
}

#endif /* OMNI_ATOMIC_H */
