// Omni stage0 — C 后端运行时（作为字符串内联进生成的 .c，保证单文件自包含）
//
// 与 backend-js/prelude.js 一一对应。任何一边改了语义，另一边必须同步改，
// 差分测试（tests/run.js）是这条约束的执行者。
//
// 容器采用宏模板（OMNI_LIST_* / OMNI_DICT_* / OMNI_SET_*）而不是 void* 泛型：
// 每个实例化都是单态化的具体类型，既零装箱，也让生成的 C 保持可读可调。
// dict/set 的插入序是 ADR-0006 的硬约束 —— 索引表（开放寻址）与条目数组分离，
// 条目数组即插入序，删除只打墓碑，因此迭代顺序与 JS 的 Map/Set 逐位一致。

export const C_RUNTIME = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <math.h>
#include <errno.h>

typedef struct { const char *p; int64_t len; } omni_str;

static void omni_error(const char *msg) {
  fflush(stdout);
  fprintf(stderr, "omni: runtime error: %s\n", msg);
  exit(70);
}

static void omni_errorf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n < 0) omni_error("formatting failed");
  char *buf = (char *)malloc((size_t)n + 1);
  if (!buf) omni_error("out of memory");
  va_start(ap, fmt);
  vsnprintf(buf, (size_t)n + 1, fmt, ap);
  va_end(ap);
  omni_error(buf);
}

static void *omni_alloc(size_t n) {
  void *p = malloc(n);
  if (!p) omni_error("out of memory");
  return p;
}

static void *omni_realloc(void *p, size_t n) {
  void *q = realloc(p, n);
  if (!q) omni_error("out of memory");
  return q;
}

/* class 引用的显式空检查：C 侧不能让它变成段错误，否则和 JS 后端的诊断分叉 */
static void *omni_nullck(void *p) {
  if (!p) omni_error("null reference");
  return p;
}

/* i64 算术：C 的有符号溢出是 UB，这里全部走无符号回绕，
   以便和 JS 后端的 BigInt.asIntN(64) 逐位一致 */
static int64_t omni_add(int64_t a, int64_t b) { return (int64_t)((uint64_t)a + (uint64_t)b); }
static int64_t omni_sub(int64_t a, int64_t b) { return (int64_t)((uint64_t)a - (uint64_t)b); }
static int64_t omni_mul(int64_t a, int64_t b) { return (int64_t)((uint64_t)a * (uint64_t)b); }
static int64_t omni_neg(int64_t a) { return (int64_t)(0u - (uint64_t)a); }
static int64_t omni_shl(int64_t a, int64_t b) { return (int64_t)((uint64_t)a << (b & 63)); }
static int64_t omni_shr(int64_t a, int64_t b) { return a >> (b & 63); }

static int64_t omni_div(int64_t a, int64_t b) {
  if (b == 0) omni_error("division by zero");
  if (a == INT64_MIN && b == -1) return INT64_MIN;
  return a / b;
}

static int64_t omni_mod(int64_t a, int64_t b) {
  if (b == 0) omni_error("division by zero");
  if (a == INT64_MIN && b == -1) return 0;
  return a % b;
}

/* ------------------------------------------------------------------ 字符串 */
/* string 是不可变 UTF-8 字节序列，因此 substr 可以直接别名原缓冲区，不拷贝 */

static omni_str omni_str_new(const char *p, int64_t len) {
  omni_str s; s.p = p; s.len = len; return s;
}

static omni_str omni_str_cat(omni_str a, omni_str b) {
  char *buf = (char *)omni_alloc((size_t)(a.len + b.len + 1));
  if (a.len) memcpy(buf, a.p, (size_t)a.len);
  if (b.len) memcpy(buf + a.len, b.p, (size_t)b.len);
  buf[a.len + b.len] = 0;
  return omni_str_new(buf, a.len + b.len);
}

/* 按字节比较（UTF-8 字节序 == 码点序）；长度不同时短者在前 */
static int omni_str_cmp(omni_str a, omni_str b) {
  int64_t n = a.len < b.len ? a.len : b.len;
  int c = n ? memcmp(a.p, b.p, (size_t)n) : 0;
  if (c) return c;
  return a.len == b.len ? 0 : (a.len < b.len ? -1 : 1);
}

static omni_str omni_str_fmt(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n < 0) omni_error("formatting failed");
  char *buf = (char *)omni_alloc((size_t)n + 1);
  va_start(ap, fmt);
  vsnprintf(buf, (size_t)n + 1, fmt, ap);
  va_end(ap);
  return omni_str_new(buf, n);
}

static omni_str omni_str_int(int64_t v) { return omni_str_fmt("%lld", (long long)v); }
static omni_str omni_str_real(double v) { return omni_str_fmt("%.6g", v); }
static omni_str omni_str_bool(bool v) { return omni_str_new(v ? "true" : "false", v ? 4 : 5); }
static omni_str omni_str_string(omni_str v) { return v; }

static void omni_print_int(int64_t v) { printf("%lld\n", (long long)v); }
static void omni_print_real(double v) { printf("%.6g\n", v); }
static void omni_print_bool(bool v) { printf("%s\n", v ? "true" : "false"); }
static void omni_print_string(omni_str v) { printf("%.*s\n", (int)v.len, v.p); }

static void omni_fail(omni_str msg) {
  fflush(stdout);
  fprintf(stderr, "omni: runtime error: %.*s\n", (int)msg.len, msg.p);
  exit(70);
}

static int64_t omni_trunc(double v) {
  if (!isfinite(v)) omni_error("cannot convert non-finite real to int");
  double t = trunc(v);
  /* 超范围的 (int64_t) 转换在 C 里是 UB（arm64 饱和，x86 给 INT64_MIN），所以先自己挡住。
     这里刻意不回绕：算术回绕是 i64 的约定（ADR-0005），但 int(1e20) 回绕出来的数
     不表示任何东西，静默给个垃圾值比报错糟。 */
  if (t < -9223372036854775808.0 || t >= 9223372036854775808.0) {
    omni_errorf("real %.6g is out of int range", v);
  }
  return (int64_t)t;
}

static int64_t omni_str_len(omni_str s) { return s.len; }

static int64_t omni_byte_at(omni_str s, int64_t i) {
  if (i < 0 || i >= s.len) {
    omni_errorf("string index out of range: %lld (length %lld)", (long long)i, (long long)s.len);
  }
  return (int64_t)(unsigned char)s.p[i];
}

static omni_str omni_substr(omni_str s, int64_t start, int64_t len) {
  if (start < 0 || len < 0 || start + len > s.len) {
    omni_errorf("substring out of range: start %lld, length %lld (string length %lld)",
                (long long)start, (long long)len, (long long)s.len);
  }
  return omni_str_new(s.p + start, len);
}

static int64_t omni_index_of(omni_str s, omni_str needle) {
  for (int64_t i = 0; i + needle.len <= s.len; i++) {
    if (needle.len == 0 || memcmp(s.p + i, needle.p, (size_t)needle.len) == 0) return i;
  }
  return -1;
}

/* JS 的 String.fromCodePoint 对代理区返回孤立代理，写出去就是 U+FFFD，这里保持一致 */
static omni_str omni_chr(int64_t cp) {
  if (cp < 0 || cp > 0x10ffff) {
    omni_errorf("chr(): code point out of range: %lld", (long long)cp);
  }
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
  char *b = (char *)omni_alloc(5);
  int64_t n;
  if (cp < 0x80) { b[0] = (char)cp; n = 1; }
  else if (cp < 0x800) { b[0] = (char)(0xc0 | (cp >> 6)); b[1] = (char)(0x80 | (cp & 0x3f)); n = 2; }
  else if (cp < 0x10000) {
    b[0] = (char)(0xe0 | (cp >> 12));
    b[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
    b[2] = (char)(0x80 | (cp & 0x3f));
    n = 3;
  } else {
    b[0] = (char)(0xf0 | (cp >> 18));
    b[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
    b[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
    b[3] = (char)(0x80 | (cp & 0x3f));
    n = 4;
  }
  b[n] = 0;
  return omni_str_new(b, n);
}

static char *omni_cstr(omni_str s) {
  char *b = (char *)omni_alloc((size_t)s.len + 1);
  if (s.len) memcpy(b, s.p, (size_t)s.len);
  b[s.len] = 0;
  return b;
}

static int64_t omni_int_of_string(omni_str s) {
  int64_t i = 0;
  if (i < s.len && (s.p[i] == '+' || s.p[i] == '-')) i++;
  int64_t digits = 0;
  for (; i < s.len; i++, digits++) if (s.p[i] < '0' || s.p[i] > '9') break;
  if (digits == 0 || i != s.len) omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
  char *c = omni_cstr(s);
  errno = 0;
  char *end = NULL;
  long long v = strtoll(c, &end, 10);
  if (errno == ERANGE || *end) omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
  free(c);
  return (int64_t)v;
}

static double omni_real_of_string(omni_str s) {
  /* 与 JS 侧同一条文法：[+-]?(D+.D* | .D+)([eE][+-]?D+)? */
  int64_t i = 0;
  if (i < s.len && (s.p[i] == '+' || s.p[i] == '-')) i++;
  int64_t intd = 0, frad = 0;
  while (i < s.len && s.p[i] >= '0' && s.p[i] <= '9') { i++; intd++; }
  if (i < s.len && s.p[i] == '.') {
    i++;
    while (i < s.len && s.p[i] >= '0' && s.p[i] <= '9') { i++; frad++; }
  }
  bool ok = intd > 0 || frad > 0;
  if (ok && i < s.len && (s.p[i] == 'e' || s.p[i] == 'E')) {
    i++;
    if (i < s.len && (s.p[i] == '+' || s.p[i] == '-')) i++;
    int64_t expd = 0;
    while (i < s.len && s.p[i] >= '0' && s.p[i] <= '9') { i++; expd++; }
    if (expd == 0) ok = false;
  }
  if (!ok || i != s.len) omni_errorf("invalid real: \"%.*s\"", (int)s.len, s.p);
  char *c = omni_cstr(s);
  double v = strtod(c, NULL);
  free(c);
  return v;
}

/* 序列化用：取 15/16/17 位里第一个能往返的，两个后端做同一件事，结果逐位一致。
   末尾补 ".0"：否则整数值的 real 序列化成 "1000"，再解析回来就变成 int 了 —— 类型往返也要无损。 */
static omni_str omni_repr_tail(const char *s) {
  if (strchr(s, '.') || strchr(s, 'e')) return omni_str_fmt("%s", s);
  return omni_str_fmt("%s.0", s);
}

static omni_str omni_repr_real(double v) {
  if (!isfinite(v)) omni_error("cannot represent non-finite real");
  char buf[64];
  for (int p = 15; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*g", p, v);
    if (strtod(buf, NULL) == v) return omni_repr_tail(buf);
  }
  snprintf(buf, sizeof buf, "%.17g", v);
  return omni_repr_tail(buf);
}

/* ------------------------------------------------------------------ dynamic */
/* 带标签的胖值。容器载荷存 void*（容器类型都是指针 typedef），
   这样 omni_dyn 可以先于任何容器实例化定义，避免定义环。 */

enum {
  OMNI_DYN_NULL = 0, OMNI_DYN_BOOL, OMNI_DYN_INT, OMNI_DYN_REAL,
  OMNI_DYN_STRING, OMNI_DYN_LIST, OMNI_DYN_DICT
};

typedef struct {
  int tag;
  union { bool b; int64_t i; double r; omni_str s; void *ref; } u;
} omni_dyn;

static const char *omni_dyn_tag_name(int t) {
  static const char *names[] = { "null", "bool", "int", "real", "string", "list", "dict" };
  return names[t];
}

static omni_dyn omni_dyn_null(void) { omni_dyn d; d.tag = OMNI_DYN_NULL; d.u.i = 0; return d; }
static omni_dyn omni_dyn_of_bool(bool v) { omni_dyn d; d.tag = OMNI_DYN_BOOL; d.u.b = v; return d; }
static omni_dyn omni_dyn_of_int(int64_t v) { omni_dyn d; d.tag = OMNI_DYN_INT; d.u.i = v; return d; }
static omni_dyn omni_dyn_of_real(double v) { omni_dyn d; d.tag = OMNI_DYN_REAL; d.u.r = v; return d; }
static omni_dyn omni_dyn_of_string(omni_str v) { omni_dyn d; d.tag = OMNI_DYN_STRING; d.u.s = v; return d; }
static omni_dyn omni_dyn_of_ref(void *v, int tag) { omni_dyn d; d.tag = tag; d.u.ref = v; return d; }

static omni_str omni_dyn_tag(omni_dyn v) {
  const char *n = omni_dyn_tag_name(v.tag);
  return omni_str_new(n, (int64_t)strlen(n));
}

static void omni_dyn_want(omni_dyn v, int tag) {
  if (v.tag != tag) {
    omni_errorf("dynamic value is %s, expected %s", omni_dyn_tag_name(v.tag), omni_dyn_tag_name(tag));
  }
}

static bool omni_dyn_as_bool(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_BOOL); return v.u.b; }
static int64_t omni_dyn_as_int(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_INT); return v.u.i; }
static double omni_dyn_as_real(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_REAL); return v.u.r; }
static omni_str omni_dyn_as_string(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_STRING); return v.u.s; }
static void *omni_dyn_as_ref(omni_dyn v, int tag) { omni_dyn_want(v, tag); return v.u.ref; }

static bool omni_dyn_eq(omni_dyn a, omni_dyn b) {
  if (a.tag != b.tag) return false;
  switch (a.tag) {
    case OMNI_DYN_NULL: return true;
    case OMNI_DYN_BOOL: return a.u.b == b.u.b;
    case OMNI_DYN_INT: return a.u.i == b.u.i;
    case OMNI_DYN_REAL: return a.u.r == b.u.r;
    case OMNI_DYN_STRING: return omni_str_cmp(a.u.s, b.u.s) == 0;
    default: return a.u.ref == b.u.ref;  /* 容器按引用相等，和 JS 侧一致 */
  }
}

/* --------------------------------------------------- 键的 hash / eq / 显示 */
/* eq 语义对齐 JS 的 SameValueZero：NaN 等于自身，+0 等于 -0 */

static int64_t omni_hash_int(int64_t k) {
  uint64_t x = (uint64_t)k;
  x ^= x >> 33; x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ULL;
  x ^= x >> 33;
  return (int64_t)x;
}
static bool omni_eq_int(int64_t a, int64_t b) { return a == b; }
static omni_str omni_kstr_int(int64_t k) { return omni_str_int(k); }

static int64_t omni_hash_real(double k) {
  double d = (k == 0.0) ? 0.0 : k;
  uint64_t bits;
  if (isnan(d)) return omni_hash_int(0x7ff8000000000000LL);
  memcpy(&bits, &d, sizeof bits);
  return omni_hash_int((int64_t)bits);
}
static bool omni_eq_real(double a, double b) { return a == b || (isnan(a) && isnan(b)); }
static omni_str omni_kstr_real(double k) { return omni_str_real(k); }

static int64_t omni_hash_bool(bool k) { return omni_hash_int(k ? 1 : 0); }
static bool omni_eq_bool(bool a, bool b) { return a == b; }
static omni_str omni_kstr_bool(bool k) { return omni_str_bool(k); }

static int64_t omni_hash_string(omni_str s) {
  uint64_t h = 1469598103934665603ULL;  /* FNV-1a 64 */
  for (int64_t i = 0; i < s.len; i++) { h ^= (unsigned char)s.p[i]; h *= 1099511628211ULL; }
  return (int64_t)h;
}
static bool omni_eq_string(omni_str a, omni_str b) { return omni_str_cmp(a, b) == 0; }
static omni_str omni_kstr_string(omni_str s) { return omni_str_fmt("\"%.*s\"", (int)s.len, s.p); }

static int64_t omni_hash_dyn(omni_dyn v) { return omni_hash_int(v.tag); }
static bool omni_eq_dyn(omni_dyn a, omni_dyn b) { return omni_dyn_eq(a, b); }
static bool omni_eq_ref(void *a, void *b) { return a == b; }

/* ------------------------------------------------------------------ 容器 */
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

/* dict：条目数组保持插入序（ADR-0006 硬约束），另有一张开放寻址索引表。
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

/* ------------------------------------------------------- dynamic 的运行期分派 */
/* ADR-0008 第 5 节的封闭清单。要用到具体容器类型（list<dynamic> / dict<string,dynamic>），
   所以做成宏，由 C 后端在这两个容器定义之后展开一次。 */
#define OMNI_DYN_BRIDGE(LT, DT) \
static LT omni_dyn_keys_of(omni_dyn v) { \
  DT d = (DT)omni_dyn_as_ref(v, OMNI_DYN_DICT); \
  LT a = LT##_new(); \
  LT##_reserve(a, d->count); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) a->items[a->len++] = omni_dyn_of_string(d->keys[i]); \
  return a; \
} \
static omni_dyn omni_dyn_get(omni_dyn v, omni_dyn k) { \
  if (v.tag == OMNI_DYN_LIST) { \
    if (k.tag != OMNI_DYN_INT) omni_errorf("list index must be int, found %s", omni_dyn_tag_name(k.tag)); \
    return LT##_get((LT)v.u.ref, k.u.i); \
  } \
  if (v.tag == OMNI_DYN_DICT) { \
    if (k.tag != OMNI_DYN_STRING) omni_errorf("dict key must be string, found %s", omni_dyn_tag_name(k.tag)); \
    return DT##_get((DT)v.u.ref, k.u.s); \
  } \
  omni_errorf("cannot index a dynamic value of tag %s", omni_dyn_tag_name(v.tag)); \
  return omni_dyn_null(); \
} \
static omni_dyn omni_dyn_set_at(omni_dyn v, omni_dyn k, omni_dyn x) { \
  if (v.tag == OMNI_DYN_LIST) { \
    if (k.tag != OMNI_DYN_INT) omni_errorf("list index must be int, found %s", omni_dyn_tag_name(k.tag)); \
    return LT##_set((LT)v.u.ref, k.u.i, x); \
  } \
  if (v.tag == OMNI_DYN_DICT) { \
    if (k.tag != OMNI_DYN_STRING) omni_errorf("dict key must be string, found %s", omni_dyn_tag_name(k.tag)); \
    return DT##_set((DT)v.u.ref, k.u.s, x); \
  } \
  omni_errorf("cannot index a dynamic value of tag %s", omni_dyn_tag_name(v.tag)); \
  return omni_dyn_null(); \
} \
static int64_t omni_dyn_len(omni_dyn v) { \
  if (v.tag == OMNI_DYN_LIST) return ((LT)v.u.ref)->len; \
  if (v.tag == OMNI_DYN_DICT) return ((DT)v.u.ref)->count; \
  if (v.tag == OMNI_DYN_STRING) return v.u.s.len; \
  omni_errorf("dynamic value of tag %s has no length", omni_dyn_tag_name(v.tag)); \
  return 0; \
} \
static LT omni_dyn_iter(omni_dyn v) { \
  if (v.tag == OMNI_DYN_LIST) return (LT)v.u.ref; \
  if (v.tag == OMNI_DYN_DICT) return omni_dyn_keys_of(v); \
  omni_errorf("cannot iterate a dynamic value of tag %s", omni_dyn_tag_name(v.tag)); \
  return NULL; \
} \
static void omni_dyn_push(omni_dyn v, omni_dyn x) { \
  LT##_push((LT)omni_dyn_as_ref(v, OMNI_DYN_LIST), x); \
} \
static bool omni_dyn_has(omni_dyn v, omni_dyn k) { \
  return DT##_contains((DT)omni_dyn_as_ref(v, OMNI_DYN_DICT), omni_dyn_as_string(k)); \
}
`;
