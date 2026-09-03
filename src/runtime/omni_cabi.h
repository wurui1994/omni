/* 外部 C 符号的 marshal 层（ADR-0014 决策 4）。
 *
 * 一端是 dynamic（JS 域的值），另一端是别人的共享库。每个类型一进一出两个函数，
 * 表在 src/hir/c_abi.js（C_IN / C_OUT），名字必须与那边逐字对上。
 *
 * 三条口径要写清楚：
 * 1. JS 域的数是 double（OMNI_DYN_REAL），Omni 域的是 int64（OMNI_DYN_INT）。两种都收，
 *    取整按 JS 的口径（截断向零，NaN 归 0）—— 和 omni_js_arr_i 同一套规则。
 * 2. cstr 出去的时候要 NUL 结尾。omni_s16_to_utf8 本来就在末尾补了 '\0'（omni_str16.c），
 *    所以直接拿它的 .p；缓冲区在 arena 上，调用期间不会被挪走（ADR-0013 决策 3）。
 * 3. ptr 用 INT 标签承载地址，不用 REAL —— double 只有 53 位尾数，而地址是 64 位。
 *    JS 侧看到的是一个 bigint，除了原样传回去没有别的用途，这是刻意的。
 */
#ifndef OMNI_CABI_H
#define OMNI_CABI_H

static inline int64_t omni_cabi_i64(omni_dyn v) {
  if (v.tag == OMNI_DYN_INT) return v.u.i;
  if (v.tag == OMNI_DYN_REAL) {
    if (isnan(v.u.r)) return 0;
    if (v.u.r >= 9.2233720368547758e18) return INT64_MAX;
    if (v.u.r <= -9.2233720368547758e18) return INT64_MIN;
    return (int64_t)v.u.r;
  }
  if (v.tag == OMNI_DYN_BOOL) return v.u.b ? 1 : 0;
  omni_errorf("a C integer argument cannot be a %s", omni_dyn_tag_name(v.tag));
  return 0;
}

static inline int32_t omni_cabi_i32(omni_dyn v) { return (int32_t)omni_cabi_i64(v); }

static inline double omni_cabi_f64(omni_dyn v) {
  if (v.tag == OMNI_DYN_REAL) return v.u.r;
  if (v.tag == OMNI_DYN_INT) return (double)v.u.i;
  if (v.tag == OMNI_DYN_BOOL) return v.u.b ? 1.0 : 0.0;
  omni_errorf("a C double argument cannot be a %s", omni_dyn_tag_name(v.tag));
  return 0.0;
}

static inline bool omni_cabi_bool(omni_dyn v) { return omni_js_truthy(v); }

static inline const char *omni_cabi_cstr(omni_dyn v) {
  if (v.tag == OMNI_DYN_NULL || v.tag == OMNI_DYN_UNDEF) return NULL;
  if (v.tag == OMNI_DYN_STRING) {
    /* 已经是 UTF-8，但不保证 NUL 结尾 —— 抄一份补上 */
    char *p = (char *)omni_alloc((size_t)v.u.s.len + 1);
    if (v.u.s.len > 0) memcpy(p, v.u.s.p, (size_t)v.u.s.len);
    p[v.u.s.len] = '\0';
    return p;
  }
  return omni_s16_to_utf8(omni_js_as_s16(v)).p;
}

static inline void *omni_cabi_ptr(omni_dyn v) {
  if (v.tag == OMNI_DYN_NULL || v.tag == OMNI_DYN_UNDEF) return NULL;
  if (v.tag == OMNI_DYN_INT) return (void *)(intptr_t)v.u.i;
  omni_errorf("a C pointer argument must be a handle, found %s", omni_dyn_tag_name(v.tag));
  return NULL;
}

static inline omni_dyn omni_cabi_of_i32(int32_t x) { return omni_dyn_of_real((double)x); }
static inline omni_dyn omni_cabi_of_i64(int64_t x) { return omni_dyn_of_real((double)x); }
static inline omni_dyn omni_cabi_of_f64(double x) { return omni_dyn_of_real(x); }
static inline omni_dyn omni_cabi_of_bool(bool x) { return omni_dyn_of_bool(x); }

/* 地址回到 dynamic 用 INT 标签，见文件头第 3 条。NULL 回成 null 而不是 0，
   于是 `if (p)` 在 JS 侧成立 —— 0 在 JS 里也是假，但 null 更能表达"没有这个东西"。 */
static inline omni_dyn omni_cabi_of_ptr(void *p) {
  if (p == NULL) return omni_dyn_null();
  omni_dyn d;
  d.tag = OMNI_DYN_INT;
  d.u.i = (int64_t)(intptr_t)p;
  return d;
}

static inline omni_dyn omni_cabi_of_cstr(const char *p) {
  if (p == NULL) return omni_dyn_null();
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(p, (int64_t)strlen(p))));
}

#endif /* OMNI_CABI_H */
