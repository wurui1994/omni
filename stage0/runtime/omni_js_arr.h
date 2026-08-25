/* JS 的 Array（ADR-0011 的 ABI 里 js_arr_* 那一段）
 *
 * 为什么是宏而不是 .c：这些 op 要造和读 list<dynamic>，而 list<dynamic> 是生成 TU 里的
 * 宏实例，运行时的翻译单元看不见它。跟 omni_dyn_bridge.h 同一个道理、同一个做法。
 *
 * 每一条都必须和 backend-js/prelude.js 里的 $js_arr_* 逐位对应，判据是 tests/oir
 * 里拿 node 当参照跑出来一样。
 *
 * 下标与 length 都是 JS 的 Number（Omni 的 real），不是 int —— 这是 ADR-0011 第 5 节
 * 的直接后果，别在这里悄悄换成 int64 口径。
 *
 * 注意宏体里**每一行**都得有行尾反斜杠，注释行也要：反斜杠续行发生在删注释之前，
 * 一行漏了宏就在那里断掉，而且报的错离现场很远。所以解释一律写在 #define 外面。
 */
#ifndef OMNI_JS_ARR_H
#define OMNI_JS_ARR_H

/* omni_js_call：JS 的函数在 Omni 里只有一个签名 fn(list<dynamic>) -> dynamic
   （ADR-0011 第 1 节），所以回调不需要按签名分派，装好实参表直接调。
   omni_js_call3 是 map/filter/forEach 那批的固定三实参形式（值、下标、数组本身）。 */
#define OMNI_JS_ARR(LT, DT) \
static omni_dyn omni_js_call(omni_dyn f, LT args) { \
  omni_fn fp = omni_js_as_fn(f); \
  return ((omni_dyn (*)(omni_fn, LT))omni_fn_ck(fp)->fp)(fp, args); \
} \
static omni_dyn omni_js_call3(omni_dyn f, omni_dyn a, int64_t i, omni_dyn self) { \
  LT args = LT##_new(); \
  LT##_reserve(args, 3); \
  args->items[0] = a; \
  args->items[1] = omni_dyn_of_real((double)i); \
  args->items[2] = self; \
  args->len = 3; \
  return omni_js_call(f, args); \
} \
/* 成员派发的兜底（ADR-0011 决策 12）：接收者的标签没有内建实现时，o.m(x) 就是
   "取属性，再当函数调"。派发器的形参个数是表里的最大值，末尾多出来的 undefined
   等于没给 —— 削掉再调，这样 (...xs) => xs.length 两边才一致。 */ \
static omni_dyn omni_js_call_n(omni_dyn f, int64_t n, const omni_dyn *a) { \
  while (n > 0 && a[n - 1].tag == OMNI_DYN_UNDEF) n--; \
  LT args = LT##_new(); \
  if (n > 0) { \
    LT##_reserve(args, n); \
    for (int64_t i = 0; i < n; i++) args->items[i] = a[i]; \
    args->len = n; \
  } \
  return omni_js_call(f, args); \
} \
static LT omni_js_arr_of(omni_dyn v) { return (LT)omni_dyn_as_ref(v, OMNI_DYN_LIST); } \
static omni_dyn omni_js_arr_wrap(LT l) { return omni_dyn_of_ref((void *)l, OMNI_DYN_LIST); } \
static omni_dyn omni_js_arr_new(void) { return omni_js_arr_wrap(LT##_new()); } \
static omni_dyn omni_js_arr_len(omni_dyn a) { \
  return omni_dyn_of_real((double)omni_js_arr_of(a)->len); \
} \
static int64_t omni_js_arr_i(omni_dyn i) { \
  if (i.tag != OMNI_DYN_REAL) { \
    omni_errorf("array index must be a number, found %s", omni_dyn_tag_name(i.tag)); \
  } \
  if (isnan(i.u.r)) return 0; \
  if (i.u.r >= 9.2233720368547758e18) return INT64_MAX; \
  if (i.u.r <= -9.2233720368547758e18) return INT64_MIN; \
  return (int64_t)i.u.r; \
} \
static omni_dyn omni_js_arr_get(omni_dyn a, omni_dyn i) { \
  LT l = omni_js_arr_of(a); \
  int64_t k = omni_js_arr_i(i); \
  return (k < 0 || k >= l->len) ? omni_dyn_undef() : l->items[k]; \
} \
static void omni_js_arr_set(omni_dyn a, omni_dyn i, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  int64_t k = omni_js_arr_i(i); \
  if (k < 0) omni_errorf("negative array index %lld", (long long)k); \
  if (k >= l->len) { \
    LT##_reserve(l, k + 1); \
    for (int64_t j = l->len; j <= k; j++) l->items[j] = omni_dyn_undef(); \
    l->len = k + 1; \
  } \
  l->items[k] = v; \
} \
static omni_dyn omni_js_arr_push(omni_dyn a, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  LT##_push(l, v); \
  return omni_dyn_of_real((double)l->len); \
} \
/* a.push(x, ...ys) —— 实参先被拼成一个 list，这里整段追加。定长的 op 表达不了
   可变实参，而 push 的实参个数是源码里定的，所以摊成"一个 list"最省事。 */ \
static omni_dyn omni_js_arr_push_all(omni_dyn a, omni_dyn items) { \
  LT l = omni_js_arr_of(a); \
  LT src = omni_js_arr_of(items); \
  for (int64_t i = 0; i < src->len; i++) LT##_push(l, src->items[i]); \
  return omni_dyn_of_real((double)l->len); \
} \
static omni_dyn omni_js_arr_pop(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  if (l->len == 0) return omni_dyn_undef(); \
  return l->items[--l->len]; \
} \
OMNI_JS_ARR_2(LT, DT)

/* 第二段：切/拼/查/排序/高阶。分两个宏纯粹是为了别写出一个几百行的单条 #define，
   展开出来是同一批 static 函数。
   indexOf 用严格相等，includes 用 SameValueZero（NaN 等于自身）—— JS 就是这么不一致的。
   sort 必须是稳定的：不稳定的话同权重的元素次序会变，产出的 C 就不逐字节相同了。 */
#define OMNI_JS_ARR_2(LT, DT) \
static int64_t omni_js_arr_rel(int64_t i, int64_t len) { \
  if (i < 0) { i += len; if (i < 0) i = 0; } \
  else if (i > len) i = len; \
  return i; \
} \
static omni_dyn omni_js_arr_slice(omni_dyn a, omni_dyn s, omni_dyn e) { \
  LT l = omni_js_arr_of(a); \
  int64_t start = omni_js_arr_rel(s.tag == OMNI_DYN_UNDEF ? 0 : omni_js_arr_i(s), l->len); \
  int64_t end = omni_js_arr_rel(e.tag == OMNI_DYN_UNDEF ? l->len : omni_js_arr_i(e), l->len); \
  LT out = LT##_new(); \
  if (end > start) { \
    LT##_reserve(out, end - start); \
    for (int64_t i = start; i < end; i++) out->items[out->len++] = l->items[i]; \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_concat(omni_dyn a, omni_dyn b) { \
  LT x = omni_js_arr_of(a), y = omni_js_arr_of(b); \
  LT out = LT##_new(); \
  LT##_reserve(out, x->len + y->len); \
  for (int64_t i = 0; i < x->len; i++) out->items[out->len++] = x->items[i]; \
  for (int64_t i = 0; i < y->len; i++) out->items[out->len++] = y->items[i]; \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_reverse(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0, j = l->len - 1; i < j; i++, j--) { \
    omni_dyn t = l->items[i]; l->items[i] = l->items[j]; l->items[j] = t; \
  } \
  return a; \
} \
static omni_dyn omni_js_arr_fill(omni_dyn a, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) l->items[i] = v; \
  return a; \
} \
static bool omni_js_arr_is_array(omni_dyn v) { return v.tag == OMNI_DYN_LIST; } \
static omni_dyn omni_js_arr_from(omni_dyn v) { \
  return omni_js_arr_slice(v, omni_dyn_undef(), omni_dyn_undef()); \
} \
static omni_dyn omni_js_arr_index_of(omni_dyn a, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (omni_js_eq(true, l->items[i], v)) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
static omni_dyn omni_js_arr_last_index_of(omni_dyn a, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = l->len - 1; i >= 0; i--) { \
    if (omni_js_eq(true, l->items[i], v)) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
static bool omni_js_arr_includes(omni_dyn a, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  bool nan = v.tag == OMNI_DYN_REAL && isnan(v.u.r); \
  for (int64_t i = 0; i < l->len; i++) { \
    omni_dyn x = l->items[i]; \
    if (nan ? (x.tag == OMNI_DYN_REAL && isnan(x.u.r)) : omni_js_eq(true, x, v)) return true; \
  } \
  return false; \
} \
OMNI_JS_ARR_3(LT, DT)

/* 第三段：join 与高阶方法。
   join 里 null/undefined 拼成空串（JS 如此），缺省分隔符是逗号。
   默认排序（不给比较器）按元素的字符串形式比码元，不是按数值 —— [10,9] 排出来是
   [10,9] 而不是 [9,10]，这是 JS 的规定，照抄。 */
#define OMNI_JS_ARR_3(LT, DT) \
static omni_dyn omni_js_arr_join(omni_dyn a, omni_dyn sep) { \
  LT l = omni_js_arr_of(a); \
  omni_s16 s = sep.tag == OMNI_DYN_UNDEF \
    ? omni_s16_of_utf8(omni_str_new(",", 1)) : omni_js_as_s16(sep); \
  omni_s16 out = omni_s16_of_utf8(omni_str_new("", 0)); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (i) out = omni_s16_cat(out, s); \
    omni_dyn x = l->items[i]; \
    if (x.tag == OMNI_DYN_NULL || x.tag == OMNI_DYN_UNDEF) continue; \
    out = omni_s16_cat(out, omni_js_as_s16(omni_js_str(x))); \
  } \
  return omni_dyn_of_s16(out); \
} \
static omni_dyn omni_js_arr_map(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) out->items[out->len++] = omni_js_call3(f, l->items[i], i, a); \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_filter(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (omni_js_truthy(omni_js_call3(f, l->items[i], i, a))) LT##_push(out, l->items[i]); \
  } \
  return omni_js_arr_wrap(out); \
} \
static void omni_js_arr_for_each(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) omni_js_call3(f, l->items[i], i, a); \
} \
static bool omni_js_arr_some(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (omni_js_truthy(omni_js_call3(f, l->items[i], i, a))) return true; \
  } \
  return false; \
} \
static bool omni_js_arr_every(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (!omni_js_truthy(omni_js_call3(f, l->items[i], i, a))) return false; \
  } \
  return true; \
} \
static omni_dyn omni_js_arr_find(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (omni_js_truthy(omni_js_call3(f, l->items[i], i, a))) return l->items[i]; \
  } \
  return omni_dyn_undef(); \
} \
static omni_dyn omni_js_arr_find_index(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (omni_js_truthy(omni_js_call3(f, l->items[i], i, a))) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
OMNI_JS_ARR_4(LT, DT)

/* 第四段：reduce / flatMap / sort。
   sort 用自底向上的归并 —— 稳定，而且不递归。比较器返回 Number，只看符号；
   返回 NaN 当作 0（JS 里是"未指定"，但两个后端必须选同一种未指定行为）。 */
#define OMNI_JS_ARR_4(LT, DT) \
static omni_dyn omni_js_arr_reduce(omni_dyn a, omni_dyn f, omni_dyn init) { \
  LT l = omni_js_arr_of(a); \
  int64_t i = 0; \
  omni_dyn acc; \
  if (init.tag == OMNI_DYN_UNDEF) { \
    if (l->len == 0) omni_error("reduce of empty array with no initial value"); \
    acc = l->items[0]; i = 1; \
  } else { \
    acc = init; \
  } \
  for (; i < l->len; i++) { \
    LT args = LT##_new(); \
    LT##_reserve(args, 4); \
    args->items[0] = acc; \
    args->items[1] = l->items[i]; \
    args->items[2] = omni_dyn_of_real((double)i); \
    args->items[3] = a; \
    args->len = 4; \
    acc = omni_js_call(f, args); \
  } \
  return acc; \
} \
static omni_dyn omni_js_arr_flat_map(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  for (int64_t i = 0; i < l->len; i++) { \
    omni_dyn r = omni_js_call3(f, l->items[i], i, a); \
    if (r.tag == OMNI_DYN_LIST) { \
      LT s = (LT)r.u.ref; \
      for (int64_t j = 0; j < s->len; j++) LT##_push(out, s->items[j]); \
    } else { \
      LT##_push(out, r); \
    } \
  } \
  return omni_js_arr_wrap(out); \
} \
static int omni_js_arr_cmp(omni_dyn f, omni_dyn x, omni_dyn y) { \
  if (f.tag == OMNI_DYN_UNDEF) { \
    return omni_s16_cmp(omni_js_as_s16(omni_js_str(x)), omni_js_as_s16(omni_js_str(y))); \
  } \
  LT args = LT##_new(); \
  LT##_reserve(args, 2); \
  args->items[0] = x; \
  args->items[1] = y; \
  args->len = 2; \
  omni_dyn r = omni_js_call(f, args); \
  double d = r.tag == OMNI_DYN_REAL ? r.u.r : (r.tag == OMNI_DYN_INT ? (double)r.u.i : 0.0); \
  if (isnan(d)) return 0; \
  return d < 0 ? -1 : (d > 0 ? 1 : 0); \
} \
static omni_dyn omni_js_arr_sort(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  int64_t n = l->len; \
  if (n < 2) return a; \
  omni_dyn *buf = (omni_dyn *)omni_alloc((size_t)n * sizeof(omni_dyn)); \
  for (int64_t w = 1; w < n; w *= 2) { \
    for (int64_t lo = 0; lo < n; lo += 2 * w) { \
      int64_t mid = lo + w < n ? lo + w : n; \
      int64_t hi = lo + 2 * w < n ? lo + 2 * w : n; \
      int64_t i = lo, j = mid, k = lo; \
      while (i < mid && j < hi) { \
        buf[k++] = omni_js_arr_cmp(f, l->items[j], l->items[i]) < 0 ? l->items[j++] : l->items[i++]; \
      } \
      while (i < mid) buf[k++] = l->items[i++]; \
      while (j < hi) buf[k++] = l->items[j++]; \
      for (int64_t t = lo; t < hi; t++) l->items[t] = buf[t]; \
    } \
  } \
  return a; \
} \
static omni_dyn omni_js_arr_entries(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) { \
    LT pair = LT##_new(); \
    LT##_reserve(pair, 2); \
    pair->items[0] = omni_dyn_of_real((double)i); \
    pair->items[1] = l->items[i]; \
    pair->len = 2; \
    out->items[i] = omni_js_arr_wrap(pair); \
  } \
  out->len = l->len; \
  return omni_js_arr_wrap(out); \
}




#endif /* OMNI_JS_ARR_H */
