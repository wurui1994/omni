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
  a->items = (T *)omni_grow(a->items, sizeof(T) * (size_t)a->cap, sizeof(T) * (size_t)c); \
  a->cap = c; \
} \
static void NAME##_push(NAME a, T v) { NAME##_reserve(a, a->len + 1); a->items[a->len++] = v; } \
/* 精确分配，不走 reserve 的"最小 4 + 倍增"：`_from` 最热的用处是**每次动态调用的实参表**
   （降级后 JS 的形参就是 list<dynamic>；量过：编译整个编译器 160 万次），一个 1 元素的
   实参表按 cap=4 分配，3/4 的字节是白扔的 —— arena 不回收，扔掉的就是峰值。
   之后真要 push，reserve 会从 n 起倍增，摊还还是线性。 */ \
static NAME NAME##_from(const T *src, int64_t n) { \
  NAME a = (NAME)omni_alloc(sizeof(struct NAME##_s)); \
  a->items = n > 0 ? (T *)omni_alloc(sizeof(T) * (size_t)n) : NULL; \
  a->len = n; \
  a->cap = n > 0 ? n : 0; \
  for (int64_t i = 0; i < n; i++) a->items[i] = src[i]; \
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
   idx[h]：0 = 空槽，>0 = 条目下标+1，-1 = 墓碑（删除后仍要保持探测链）

   **idx 是 int32 而不是 int64**：这张表的大小是 (n+1)*2 向上取整到 2 的幂，也就是**总是
   比条目数大一倍以上**，所以它在内存里不是配角 —— 一个 4 条目的 dict：keys+vals 128 字节、
   idx 就要 8 格。量出来的：`omni check src/cli.js`（一个字节产物都不出）峰值 1.46 GB，
   6.5 MB 源码涨了 225 倍，而 AST 的每个节点都是一格 dict。条目数上不了 2^31，
   所以 int32 是白拿的一半。

   曾经这儿还并排存过一份完整哈希（探测时先比 8 个字节再调 EQ）。**量下来是白做的**：
   emit-c 一趟 35.6s -> 36.2s、用户 CPU 25.9 -> 25.5s，全在噪声里 —— `find` 那 2917 个
   采样是 -O0 下探测循环**本身**（没有寄存器分配、每个 static inline 都是真调用），不是比较。
   而它每个 dict 多要 icap*8 字节，正压在真正的瓶颈上，所以撤了。记在这儿免得再试一次。 */ \
/* **小表不建索引**（第一百五十八片，量出来的）：`n <= OMNI_DICT_SMALL` 时 idx 一格都不分配，
   查找就是顺着 keys 线性扫。理由有三条，都是实测的：
     1. 一格 idx 表要一次 omni_alloc + 一趟清零，而**第一次插入**就会触发它
        （`(0+1)*2 > 0`）—— AST 的每个节点、每个 token、每个 span、每个对象的属性槽表
        都是一格 dict，绝大多数只有二到五格；
     2. 走索引要先算 `HASH(k)`，而字符串哈希**要走完整个串**。四格的表上「四次长度比较 +
        至多一次 memcmp」比一次整串哈希便宜；
     3. 4 格以上还要再 rebuild 一次（icap 8 -> 16），那一趟把所有键重新哈希一遍。
   量出来：单文件那一趟（`dist/omni c obj src/runtime/omni_hash.c`）里 rebuild 自时间
   14.3% 是榜首，memmove 14.0% 里也有它的一份。
   插入序不变（keys/vals 仍然按插入顺序追加），所以迭代与 `_keys` 的输出逐字节相同。 */
#define OMNI_DICT_SMALL 8

#define OMNI_DICT_BODY(NAME, KT, VT) \
struct NAME##_s { \
  KT *keys; VT *vals; bool *live; \
  int64_t n;      /* 条目数（含墓碑） */ \
  int64_t cap; \
  int64_t count;  /* 存活条目数 */ \
  int32_t *idx; int64_t icap; \
};

#define OMNI_DICT_DEFINE(NAME, KT, VT, HASH, EQ, KSTR, LNAME) \
static NAME NAME##_new(void) { \
  NAME d = (NAME)omni_alloc(sizeof(struct NAME##_s)); \
  d->keys = NULL; d->vals = NULL; d->live = NULL; \
  d->n = 0; d->cap = 0; d->count = 0; d->idx = NULL; d->icap = 0; \
  return d; \
} \
/* 哈希已经算好的那一份入口：键是编译期字面量时（backend-c 的 constKey 那条特化）
   哈希也是编译期常量，于是连 HASH(k) 都不必再走一趟。 */ \
static int64_t NAME##_find_h(NAME d, KT k, uint64_t hv) { \
  if (d->icap == 0) { \
    /* 小表那一档：线性扫，连 hv 都不看（见 OMNI_DICT_SMALL 那段） */ \
    for (int64_t i = 0; i < d->n; i++) if (d->live[i] && EQ(d->keys[i], k)) return i; \
    return -1; \
  } \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = hv & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int32_t e = d->idx[h]; \
    if (e == 0) return -1; \
    if (e > 0 && EQ(d->keys[e - 1], k)) return e - 1; \
    h = (h + 1) & mask; \
  } \
  return -1; \
} \
static int64_t NAME##_find(NAME d, KT k) { \
  if (d->icap == 0) return NAME##_find_h(d, k, 0);   /* 小表上不算哈希 */ \
  return NAME##_find_h(d, k, (uint64_t)HASH(k)); \
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
  d->idx = (int32_t *)omni_alloc(sizeof(int32_t) * (size_t)ic); \
  d->icap = ic; \
  for (int64_t i = 0; i < ic; i++) d->idx[i] = 0; \
  uint64_t mask = (uint64_t)ic - 1; \
  for (int64_t i = 0; i < d->n; i++) { \
    uint64_t h = (uint64_t)HASH(d->keys[i]) & mask; \
    while (d->idx[h] != 0) h = (h + 1) & mask; \
    d->idx[h] = (int32_t)(i + 1); \
  } \
} \
static int64_t NAME##_len(NAME d) { return d->count; } \
static bool NAME##_contains(NAME d, KT k) { return NAME##_find(d, k) >= 0; } \
static VT NAME##_set_h(NAME d, KT k, VT v, uint64_t hv) { \
  int64_t e = NAME##_find_h(d, k, hv); \
  if (e >= 0) { d->vals[e] = v; return v; } \
  if (d->n + 1 > d->cap) { \
    int64_t c = d->cap ? d->cap * 2 : 4; \
    d->keys = (KT *)omni_grow(d->keys, sizeof(KT) * (size_t)d->cap, sizeof(KT) * (size_t)c); \
    d->vals = (VT *)omni_grow(d->vals, sizeof(VT) * (size_t)d->cap, sizeof(VT) * (size_t)c); \
    d->live = (bool *)omni_grow(d->live, sizeof(bool) * (size_t)d->cap, sizeof(bool) * (size_t)c); \
    d->cap = c; \
  } \
  if ((d->n + 1) * 2 > d->icap) { \
    /* 小表那一档：索引一格都不建（见 OMNI_DICT_SMALL 那段） */ \
    if (d->icap == 0 && d->n + 1 <= OMNI_DICT_SMALL) { \
      int64_t s0 = d->n++; \
      d->keys[s0] = k; d->vals[s0] = v; d->live[s0] = true; d->count++; \
      return v; \
    } \
    NAME##_rebuild(d); \
  } \
  int64_t slot = d->n++; \
  d->keys[slot] = k; d->vals[slot] = v; d->live[slot] = true; d->count++; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = hv & mask; \
  while (d->idx[h] > 0) h = (h + 1) & mask; \
  d->idx[h] = (int32_t)(slot + 1); \
  return v; \
} \
/* 小表上连 `HASH(k)` 都不算 —— 那个值只有建索引时才用得上（字符串哈希要走完整个串）。
   这一句的判断与 set_h 里那一支必须同口径，否则跨过门槛的那一次会拿 hv=0 去插索引。 */ \
static VT NAME##_set(NAME d, KT k, VT v) { \
  bool small = d->icap == 0 && d->n + 1 <= OMNI_DICT_SMALL; \
  return NAME##_set_h(d, k, v, small ? 0 : (uint64_t)HASH(k)); \
} \
static VT NAME##_get(NAME d, KT k) { \
  int64_t e = NAME##_find(d, k); \
  if (e < 0) { omni_str ks = KSTR(k); omni_errorf("key not found: %.*s", (int)ks.len, ks.p); } \
  return d->vals[e < 0 ? 0 : e]; \
} \
static bool NAME##_remove(NAME d, KT k) { \
  if (d->icap == 0) { \
    /* 小表：没有索引，也就没有墓碑要维护 —— 找到就把 live 灭掉 */ \
    int64_t e = NAME##_find_h(d, k, 0); \
    if (e < 0) return false; \
    d->live[e] = false; d->count--; \
    return true; \
  } \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int32_t e = d->idx[h]; \
    if (e == 0) return false; \
    if (e > 0 && EQ(d->keys[e - 1], k)) { \
      d->live[e - 1] = false; d->idx[h] = -1; d->count--; return true; \
    } \
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

/* set 复用 dict 的索引结构，只是没有值数组（idx 同样是 int32，理由见 dict 那段） */
#define OMNI_SET_BODY(NAME, T) \
struct NAME##_s { \
  T *keys; bool *live; \
  int64_t n; int64_t cap; int64_t count; \
  int32_t *idx; int64_t icap; \
};

#define OMNI_SET_DEFINE(NAME, T, HASH, EQ, LNAME) \
static NAME NAME##_new(void) { \
  NAME d = (NAME)omni_alloc(sizeof(struct NAME##_s)); \
  d->keys = NULL; d->live = NULL; \
  d->n = 0; d->cap = 0; d->count = 0; d->idx = NULL; d->icap = 0; \
  return d; \
} \
static int64_t NAME##_find(NAME d, T k) { \
  if (d->icap == 0) { \
    /* 小表：线性扫，不算哈希（见 OMNI_DICT_SMALL 那段） */ \
    for (int64_t i = 0; i < d->n; i++) if (d->live[i] && EQ(d->keys[i], k)) return i; \
    return -1; \
  } \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int32_t e = d->idx[h]; \
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
  d->idx = (int32_t *)omni_alloc(sizeof(int32_t) * (size_t)ic); \
  d->icap = ic; \
  for (int64_t i = 0; i < ic; i++) d->idx[i] = 0; \
  uint64_t mask = (uint64_t)ic - 1; \
  for (int64_t i = 0; i < d->n; i++) { \
    uint64_t h = (uint64_t)HASH(d->keys[i]) & mask; \
    while (d->idx[h] != 0) h = (h + 1) & mask; \
    d->idx[h] = (int32_t)(i + 1); \
  } \
} \
static int64_t NAME##_len(NAME d) { return d->count; } \
static bool NAME##_contains(NAME d, T k) { return NAME##_find(d, k) >= 0; } \
static void NAME##_add(NAME d, T k) { \
  if (NAME##_find(d, k) >= 0) return; \
  if (d->n + 1 > d->cap) { \
    int64_t c = d->cap ? d->cap * 2 : 4; \
    d->keys = (T *)omni_grow(d->keys, sizeof(T) * (size_t)d->cap, sizeof(T) * (size_t)c); \
    d->live = (bool *)omni_grow(d->live, sizeof(bool) * (size_t)d->cap, sizeof(bool) * (size_t)c); \
    d->cap = c; \
  } \
  if ((d->n + 1) * 2 > d->icap) { \
    if (d->icap == 0 && d->n + 1 <= OMNI_DICT_SMALL) { \
      int64_t s0 = d->n++; \
      d->keys[s0] = k; d->live[s0] = true; d->count++; \
      return; \
    } \
    NAME##_rebuild(d); \
  } \
  int64_t slot = d->n++; \
  d->keys[slot] = k; d->live[slot] = true; d->count++; \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  while (d->idx[h] > 0) h = (h + 1) & mask; \
  d->idx[h] = (int32_t)(slot + 1); \
} \
static bool NAME##_remove(NAME d, T k) { \
  if (d->icap == 0) { \
    int64_t e = NAME##_find(d, k); \
    if (e < 0) return false; \
    d->live[e] = false; d->count--; \
    return true; \
  } \
  uint64_t mask = (uint64_t)d->icap - 1; \
  uint64_t h = (uint64_t)HASH(k) & mask; \
  for (int64_t probe = 0; probe < d->icap; probe++) { \
    int32_t e = d->idx[h]; \
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
