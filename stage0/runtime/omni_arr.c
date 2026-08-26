/* 可增长数组（ADR-0014 门槛 2 的第四刀：asy 的 `T[]`）。
 *
 * 为什么不是 `buf`：buf 是 `{长度, 指针}` **按值**传的 16 字节聚合（C 和 LLVM 两条腿都是），
 * 引用语义靠"副本里的指针指向同一段存储"得来。这对固定长度够用，但 push 要改**长度**，
 * 而长度在每份副本里各有一个 —— 别名看不到。所以数组必须多一层间接：句柄是指针，
 * 长度/容量/数据都在被指向的头里。buf 的形状不动，GPU 那条腿要的正是"按值的 {len, ptr}"。
 *
 * 为什么实现在运行时里、而不是像 buf 那样由 backend-c 逐形状生成 static inline：
 * 增长逻辑（倍增、精确分配、越界消息）有几十行，两条腿各写一份就等于埋一处必然分叉的地方。
 * 放这里，`run-c` 和 `run-llvm` 调的是**同一个符号的同一份机器码**。
 *
 * 元素类型手工单态化成四份（int/real/bool/string）而不是 void* 泛型：装箱要分配，
 * 而且生成的 C 与 IR 都会多一层看不懂的转换。四份是 X 宏展开的，代码只有一份。
 *
 * 分配走 arena（omni_alloc/omni_grow，不回收）—— 与 list 那套同一个约定，见 ADR-0007。 */
#include "omni.h"

#define OMNI_ARR_IMPL(SUF, T)                                                        \
  struct omni_arr_##SUF##_s { int64_t len; int64_t cap; T *items; };                 \
                                                                                     \
  static void omni_arr_##SUF##_reserve(omni_arr_##SUF a, int64_t n) {                 \
    if (n <= a->cap) return;                                                          \
    int64_t c = a->cap ? a->cap * 2 : 4;                                              \
    while (c < n) c *= 2;                                                             \
    a->items = (T *)omni_grow(a->items, sizeof(T) * (size_t)a->cap,                   \
                              sizeof(T) * (size_t)c);                                 \
    a->cap = c;                                                                       \
  }                                                                                   \
                                                                                      \
  omni_arr_##SUF omni_arr_##SUF##_new(int64_t n, T zero) {                            \
    if (n < 0) omni_errorf("array length cannot be negative: %lld", (long long)n);     \
    omni_arr_##SUF a = (omni_arr_##SUF)omni_alloc(sizeof(struct omni_arr_##SUF##_s));  \
    a->len = n;                                                                        \
    a->cap = n;                                                                        \
    a->items = n > 0 ? (T *)omni_alloc(sizeof(T) * (size_t)n) : NULL;                  \
    for (int64_t i = 0; i < n; i++) a->items[i] = zero;                                \
    return a;                                                                          \
  }                                                                                    \
                                                                                       \
  int64_t omni_arr_##SUF##_len(omni_arr_##SUF a) { return a->len; }                     \
                                                                                       \
  T omni_arr_##SUF##_get(omni_arr_##SUF a, int64_t i) {                                 \
    if (i < 0 || i >= a->len)                                                           \
      omni_errorf("array index out of range: %lld (length %lld)",                       \
                  (long long)i, (long long)a->len);                                     \
    return a->items[i];                                                                 \
  }                                                                                     \
                                                                                        \
  T omni_arr_##SUF##_set(omni_arr_##SUF a, int64_t i, T v) {                             \
    if (i < 0 || i >= a->len)                                                            \
      omni_errorf("array index out of range: %lld (length %lld)",                        \
                  (long long)i, (long long)a->len);                                      \
    a->items[i] = v;                                                                     \
    return v;                                                                            \
  }                                                                                      \
                                                                                         \
  T omni_arr_##SUF##_push(omni_arr_##SUF a, T v) {                                        \
    omni_arr_##SUF##_reserve(a, a->len + 1);                                              \
    a->items[a->len++] = v;                                                                \
    return v;                                                                              \
  }                                                                                        \
                                                                                           \
  T omni_arr_##SUF##_pop(omni_arr_##SUF a) {                                                \
    if (a->len == 0) omni_error("pop from empty array");                                     \
    return a->items[--a->len];                                                               \
  }

OMNI_ARR_IMPL(i64, int64_t)
OMNI_ARR_IMPL(f64, double)
OMNI_ARR_IMPL(b8, bool)
OMNI_ARR_IMPL(str, omni_str)
