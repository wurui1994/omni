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
  int64_t omni_arr_##SUF##_len(omni_arr_##SUF a) { omni_nullck(a); return a->len; }      \
                                                                                       \
  T omni_arr_##SUF##_get(omni_arr_##SUF a, int64_t i) {                                 \
    omni_nullck(a);                                                                     \
    if (i < 0 || i >= a->len)                                                           \
      omni_errorf("array index out of range: %lld (length %lld)",                       \
                  (long long)i, (long long)a->len);                                     \
    return a->items[i];                                                                 \
  }                                                                                     \
                                                                                        \
  T omni_arr_##SUF##_set(omni_arr_##SUF a, int64_t i, T v) {                             \
    omni_nullck(a);                                                                      \
    if (i < 0 || i >= a->len)                                                            \
      omni_errorf("array index out of range: %lld (length %lld)",                        \
                  (long long)i, (long long)a->len);                                      \
    a->items[i] = v;                                                                     \
    return v;                                                                            \
  }                                                                                      \
                                                                                         \
  T omni_arr_##SUF##_push(omni_arr_##SUF a, T v) {                                        \
    omni_nullck(a);                                                                       \
    omni_arr_##SUF##_reserve(a, a->len + 1);                                              \
    a->items[a->len++] = v;                                                                \
    return v;                                                                              \
  }                                                                                        \
                                                                                           \
  T omni_arr_##SUF##_pop(omni_arr_##SUF a) {                                                \
    omni_nullck(a);                                                                         \
    if (a->len == 0) omni_error("pop from empty array");                                     \
    return a->items[--a->len];                                                               \
  }

OMNI_ARR_IMPL(i64, int64_t)
OMNI_ARR_IMPL(f64, double)
OMNI_ARR_IMPL(b8, bool)
OMNI_ARR_IMPL(str, omni_str)

/* 聚合元素（第一个用户是 asy 的 `pair[]`，元素是 (vec real 2)）走这一份**按字节**的实现。
 *
 * 为什么不再多几行 X 宏：向量的 C 结构体是**逐形状生成在那份 .c 里**的
 * （`omni_vec_real_2` 之类，见 backend-c 的 vecLines），而这个文件是**预编译**的运行时 ——
 * 顺序反了，宏在这里展开不出那个类型。反过来"让 C 后端逐形状生成一份数组实现"也不行：
 * run-llvm 那条腿发的是 call，它只能调运行时里的符号，两条腿就会各有一份增长逻辑 ——
 * 那正是这个文件开头说的"必然分叉的地方"。
 *
 * 所以这一份只管字节：长度/容量/增长/越界消息都在这里（与上面四份逐字同一套话），
 * 元素的**读写**留给两条腿各自去做 —— 那是一条 load / 一条 store，与它们发局部变量
 * 读写用的是同一份代码，不存在"数组里的向量和局部变量里的向量不一样"的可能。
 * `_at`/`_push`/`_pop` 回的是**格子的地址**，值从不经过这里。 */
struct omni_arr_blob_s { int64_t len; int64_t cap; int64_t esz; char *items; };

static void omni_arr_blob_reserve(omni_arr_blob a, int64_t n) {
  if (n <= a->cap) return;
  int64_t c = a->cap ? a->cap * 2 : 4;
  while (c < n) c *= 2;
  a->items = (char *)omni_grow(a->items, (size_t)(a->esz * a->cap), (size_t)(a->esz * c));
  a->cap = c;
}

/* `zero` 在 n == 0 时允许是 NULL：下面那个 memcpy 循环跑 n 次，一次也不跑就没人读它。
   这是明写的契约，run-llvm 那条腿的结构体数组字段（零长度）就靠它 —— 不然那条路要为
   一个没人读的零值在入口块开一块 alloca。 */
omni_arr_blob omni_arr_blob_new(int64_t n, int64_t esz, const void *zero) {
  if (n < 0) omni_errorf("array length cannot be negative: %lld", (long long)n);
  omni_arr_blob a = (omni_arr_blob)omni_alloc(sizeof(struct omni_arr_blob_s));
  a->len = n;
  a->cap = n;
  a->esz = esz;
  a->items = n > 0 ? (char *)omni_alloc((size_t)(esz * n)) : NULL;
  for (int64_t i = 0; i < n; i++) memcpy(a->items + esz * i, zero, (size_t)esz);
  return a;
}

int64_t omni_arr_blob_len(omni_arr_blob a) { omni_nullck(a); return a->len; }

void *omni_arr_blob_at(omni_arr_blob a, int64_t i) {
  omni_nullck(a);
  if (i < 0 || i >= a->len)
    omni_errorf("array index out of range: %lld (length %lld)", (long long)i, (long long)a->len);
  return a->items + a->esz * i;
}

void *omni_arr_blob_push(omni_arr_blob a) {
  omni_nullck(a);
  omni_arr_blob_reserve(a, a->len + 1);
  return a->items + a->esz * a->len++;
}

void *omni_arr_blob_pop(omni_arr_blob a) {
  omni_nullck(a);
  if (a->len == 0) omni_error("pop from empty array");
  return a->items + a->esz * --a->len;
}
