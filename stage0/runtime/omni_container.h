/* 容器：单态化宏模板，不是 void* 泛型。
 *
 * 每个实例化都是具体类型，既零装箱，也让生成的 C 保持可读可调 —— 调试生成代码时
 * 你看到的是 omni_list_int_get 而不是一层 void* 转换。
 *
 * 这些宏必须在**生成的那个翻译单元**里展开（元素类型是那里才知道的），所以里面的函数
 * 都是 static；运行时的公共函数才是 extern。
 *
 * dict/set 的插入序是 ADR-0006 的硬约束：索引表（开放寻址）与条目数组分离，条目数组即
 * 插入序，删除只打墓碑，因此迭代顺序与 JS 的 Map/Set 逐位一致（包括"删掉再插入会移到末尾"）。
 */
#ifndef OMNI_CONTAINER_H
#define OMNI_CONTAINER_H

/* 所有容器都是引用语义 -> 指针 typedef。声明与定义分两步，
   于是嵌套容器（list<list<int>>）无需任何拓扑顺序假设即可自洽。 */
#define OMNI_REF_DECL(NAME) typedef struct NAME##_s *NAME;

#define OMNI_LIST_BODY(NAME, T) \
struct NAME##_s { T *items; int64_t len; int64_t cap; };

#define OMNI_LIST_DEFINE(NAME, T) \
static NAME NAME##_new(void) { \
  NAME a = (NAME)omni_alloc(sizeof(struct NAME##_s)); \
  a->items = NULL; a->len = 0; a->cap = 0; \
  return a; \
} \
static void NAME##_reserve(NAME a, int64_t n) { \
  if (n <= a->cap) return; \
  int64_t c = a->cap ? a->cap * 2 : 4; \
  while (c < n) c *= 2; \
  a->items = (T *)omni_realloc(a->items, sizeof(T) * (size_t)c); \
  a->cap = c; \
} \
static void NAME##_push(NAME a, T v) { NAME##_reserve(a, a->len + 1); a->items[a->len++] = v; } \
static NAME NAME##_from(const T *src, int64_t n) { \
  NAME a = NAME##_new(); \
  NAME##_reserve(a, n); \
  for (int64_t i = 0; i < n; i++) a->items[i] = src[i]; \
  a->len = n; \
  return a; \
} \
static int64_t NAME##_len(NAME a) { return a->len; } \
static T NAME##_get(NAME a, int64_t i) { \
  if (i < 0 || i >= a->len) omni_errorf("list index out of range: %lld (length %lld)", (long long)i, (long long)a->len); \
  return a->items[i]; \
} \
static T NAME##_set(NAME a, int64_t i, T v) { \
  if (i < 0 || i >= a->len) omni_errorf("list index out of range: %lld (length %lld)", (long long)i, (long long)a->len); \
  a->items[i] = v; \
  return v; \
} \
static T NAME##_pop(NAME a) { \
  if (a->len == 0) omni_error("pop from empty list"); \
  return a->items[--a->len]; \
} \
static void NAME##_clear(NAME a) { a->len = 0; }

/* contains 需要元素相等语义，单独一层：元素不可比较的 list 就不生成它 */
#define OMNI_LIST_EQ_DEFINE(NAME, T, EQ) \
static bool NAME##_contains(NAME a, T v) { \
  for (int64_t i = 0; i < a->len; i++) if (EQ(a->items[i], v)) return true; \
  return false; \
}

/* dict：条目数组保持插入序，另有一张开放寻址索引表。
   idx[h]：0 = 空槽，>0 = 条目下标+1，-1 = 墓碑（删除后仍要保持探测链） */
#define OMNI_DICT_BODY(NAME, KT, VT) \
struct NAME##_s { \
  KT *keys; VT *vals; bool *live; \
  int64_t n;      /* 条目数（含墓碑） */ \
  int64_t cap; \
  int64_t count;  /* 存活条目数 */ \
  int64_t *idx; int64_t icap; \
};

#define OMNI_DICT_DEFINE(NAME, KT, VT, HASH, EQ, KSTR, LNAME) \
static NAME NAME##_new(void) { \
  NAME d = (NAME)omni_alloc(sizeof(struct NAME##_s)); \
  d->keys = NULL; d->vals = NULL; d->live = NULL; \
  d->n = 0; d->cap = 0; d->count = 0; d->idx = NULL; d->icap = 0; \
  return d; \
} \
static int64_t NAME##_find(NAME d, KT k) { \
  if (d->icap == 0) return -1; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int64_t e = d->idx[h]; \
    if (e == 0) return -1; \
    if (e > 0 && EQ(d->keys[e - 1], k)) return e - 1; \
    h = (h + 1) & mask; \
  } \
  return -1; \
} \
static void NAME##_rebuild(NAME d) { \
  int64_t w = 0; \
  for (int64_t i = 0; i < d->n; i++) { \
    if (!d->live[i]) continue; \
    if (w != i) { d->keys[w] = d->keys[i]; d->vals[w] = d->vals[i]; d->live[w] = true; } \
    w++; \
  } \
  d->n = w; \
  int64_t ic = d->icap ? d->icap : 8; \
  while (ic < (d->n + 1) * 2) ic *= 2; \
  d->idx = (int64_t *)omni_realloc(d->idx, sizeof(int64_t) * (size_t)ic); \
  d->icap = ic; \
  for (int64_t i = 0; i < ic; i++) d->idx[i] = 0; \
  uint64_t mask = (uint64_t)ic - 1; \
  for (int64_t i = 0; i < d->n; i++) { \
    uint64_t h = (uint64_t)HASH(d->keys[i]) & mask; \
    while (d->idx[h] != 0) h = (h + 1) & mask; \
    d->idx[h] = i + 1; \
  } \
} \
static int64_t NAME##_len(NAME d) { return d->count; } \
static bool NAME##_contains(NAME d, KT k) { return NAME##_find(d, k) >= 0; } \
static VT NAME##_set(NAME d, KT k, VT v) { \
  int64_t e = NAME##_find(d, k); \
  if (e >= 0) { d->vals[e] = v; return v; } \
  if (d->n + 1 > d->cap) { \
    int64_t c = d->cap ? d->cap * 2 : 4; \
    d->keys = (KT *)omni_realloc(d->keys, sizeof(KT) * (size_t)c); \
    d->vals = (VT *)omni_realloc(d->vals, sizeof(VT) * (size_t)c); \
    d->live = (bool *)omni_realloc(d->live, sizeof(bool) * (size_t)c); \
    d->cap = c; \
  } \
  if ((d->n + 1) * 2 > d->icap) NAME##_rebuild(d); \
  int64_t slot = d->n++; \
  d->keys[slot] = k; d->vals[slot] = v; d->live[slot] = true; d->count++; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  while (d->idx[h] > 0) h = (h + 1) & mask; \
  d->idx[h] = slot + 1; \
  return v; \
} \
static VT NAME##_get(NAME d, KT k) { \
  int64_t e = NAME##_find(d, k); \
  if (e < 0) { omni_str ks = KSTR(k); omni_errorf("key not found: %.*s", (int)ks.len, ks.p); } \
  return d->vals[e < 0 ? 0 : e]; \
} \
static bool NAME##_remove(NAME d, KT k) { \
  if (d->icap == 0) return false; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int64_t e = d->idx[h]; \
    if (e == 0) return false; \
    if (e > 0 && EQ(d->keys[e - 1], k)) { d->live[e - 1] = false; d->idx[h] = -1; d->count--; return true; } \
    h = (h + 1) & mask; \
  } \
  return false; \
} \
static LNAME NAME##_keys(NAME d) { \
  LNAME a = LNAME##_new(); \
  LNAME##_reserve(a, d->count); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) a->items[a->len++] = d->keys[i]; \
  return a; \
} \
static NAME NAME##_from(const KT *ks, const VT *vs, int64_t n) { \
  NAME d = NAME##_new(); \
  for (int64_t i = 0; i < n; i++) NAME##_set(d, ks[i], vs[i]); \
  return d; \
}

/* set 复用 dict 的索引结构，只是没有值数组 */
#define OMNI_SET_BODY(NAME, T) \
struct NAME##_s { \
  T *keys; bool *live; \
  int64_t n; int64_t cap; int64_t count; \
  int64_t *idx; int64_t icap; \
};

#define OMNI_SET_DEFINE(NAME, T, HASH, EQ, LNAME) \
static NAME NAME##_new(void) { \
  NAME d = (NAME)omni_alloc(sizeof(struct NAME##_s)); \
  d->keys = NULL; d->live = NULL; \
  d->n = 0; d->cap = 0; d->count = 0; d->idx = NULL; d->icap = 0; \
  return d; \
} \
static int64_t NAME##_find(NAME d, T k) { \
  if (d->icap == 0) return -1; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int64_t e = d->idx[h]; \
    if (e == 0) return -1; \
    if (e > 0 && EQ(d->keys[e - 1], k)) return e - 1; \
    h = (h + 1) & mask; \
  } \
  return -1; \
} \
static void NAME##_rebuild(NAME d) { \
  int64_t w = 0; \
  for (int64_t i = 0; i < d->n; i++) { \
    if (!d->live[i]) continue; \
    if (w != i) { d->keys[w] = d->keys[i]; d->live[w] = true; } \
    w++; \
  } \
  d->n = w; \
  int64_t ic = d->icap ? d->icap : 8; \
  while (ic < (d->n + 1) * 2) ic *= 2; \
  d->idx = (int64_t *)omni_realloc(d->idx, sizeof(int64_t) * (size_t)ic); \
  d->icap = ic; \
  for (int64_t i = 0; i < ic; i++) d->idx[i] = 0; \
  uint64_t mask = (uint64_t)ic - 1; \
  for (int64_t i = 0; i < d->n; i++) { \
    uint64_t h = (uint64_t)HASH(d->keys[i]) & mask; \
    while (d->idx[h] != 0) h = (h + 1) & mask; \
    d->idx[h] = i + 1; \
  } \
} \
static int64_t NAME##_len(NAME d) { return d->count; } \
static bool NAME##_contains(NAME d, T k) { return NAME##_find(d, k) >= 0; } \
static void NAME##_add(NAME d, T k) { \
  if (NAME##_find(d, k) >= 0) return; \
  if (d->n + 1 > d->cap) { \
    int64_t c = d->cap ? d->cap * 2 : 4; \
    d->keys = (T *)omni_realloc(d->keys, sizeof(T) * (size_t)c); \
    d->live = (bool *)omni_realloc(d->live, sizeof(bool) * (size_t)c); \
    d->cap = c; \
  } \
  if ((d->n + 1) * 2 > d->icap) NAME##_rebuild(d); \
  int64_t slot = d->n++; \
  d->keys[slot] = k; d->live[slot] = true; d->count++; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  while (d->idx[h] > 0) h = (h + 1) & mask; \
  d->idx[h] = slot + 1; \
} \
static bool NAME##_remove(NAME d, T k) { \
  if (d->icap == 0) return false; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int64_t e = d->idx[h]; \
    if (e == 0) return false; \
    if (e > 0 && EQ(d->keys[e - 1], k)) { d->live[e - 1] = false; d->idx[h] = -1; d->count--; return true; } \
    h = (h + 1) & mask; \
  } \
  return false; \
} \
static LNAME NAME##_items(NAME d) { \
  LNAME a = LNAME##_new(); \
  LNAME##_reserve(a, d->count); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) a->items[a->len++] = d->keys[i]; \
  return a; \
} \
static NAME NAME##_from(const T *ks, int64_t n) { \
  NAME d = NAME##_new(); \
  for (int64_t i = 0; i < n; i++) NAME##_add(d, ks[i]); \
  return d; \
}

#endif /* OMNI_CONTAINER_H */
