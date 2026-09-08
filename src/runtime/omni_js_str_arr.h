/* JS 的 String 里"结果是数组"的那几个（ADR-0011 的 ABI）
 *
 * 和 omni_js_str.c 分开只有一个原因：这几个要造 list<dynamic>，而 list<dynamic> 是
 * 生成 TU 里的宏实例，运行时的翻译单元看不见它。必须在 OMNI_JS_ARR 之后展开
 * （用它的 omni_js_arr_wrap）。
 *
 * 注意宏体里**每一行**都得有行尾反斜杠，注释行也要（反斜杠续行发生在删注释之前），
 * 所以解释一律写在 #define 外面。
 */
#ifndef OMNI_JS_STR_ARR_H
#define OMNI_JS_STR_ARR_H

/* split(字符串分隔符)：正则形式在 omni_js_re.h 里，这里只管字符串。
   照 JS：分隔符是空串就切成一个个码元（不是按码点，代理对会被切开）；
   分隔符找不到就返回只有原串的数组；相邻两个分隔符之间产出空串。
   量过的用法只有 spec.split('/') 与 source.split('\n')，都不带 limit，所以不收 limit。

   utf8_bytes：Buffer.from(s, 'utf8') 的替身。全仓库只有 backend-c 的字符串字面量
   用它（一次 Buffer.from + 遍历字节），所以只给"UTF-8 字节的数组"这一个形状。

   iter：for-of 的取值面。数组**原样返回**（下标迭代因此是活的，和 JS 一致）；
   字符串按**码点**切（JS 的字符串迭代器是码点，不是码元）；Map 给 [k,v] 对，
   Set 给元素。普通对象不可迭代 —— JS 也是这样，当场报错。

   idx_get / idx_set：o[k] 的运行期派发。数组按下标、字符串按码元（只读）、
   普通对象按属性名。Map/Set 用 o[k] 在 JS 里是访问属性而不是条目，量过的源码里
   没有这种写法，所以当场报错而不是猜。 */
#define OMNI_JS_STR_ARR(LT, DT) \
static omni_dyn omni_js_str_split(omni_dyn sd, omni_dyn sepd) { \
  omni_s16 s = omni_js_as_s16(sd); \
  omni_s16 sep = omni_js_as_s16(sepd); \
  LT out = LT##_new(); \
  if (sep.len == 0) { \
    LT##_reserve(out, s.len); \
    for (int64_t i = 0; i < s.len; i++) out->items[i] = omni_dyn_of_s16(omni_s16_slice(s, i, i + 1)); \
    out->len = s.len; \
    return omni_js_arr_wrap(out); \
  } \
  int64_t p = 0; \
  for (;;) { \
    int64_t at = omni_s16_index_of(s, sep, p); \
    if (at < 0) break; \
    LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, p, at))); \
    p = at + sep.len; \
  } \
  LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, p, s.len))); \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_utf8_bytes(omni_dyn sd) { \
  omni_str u = omni_s16_to_utf8(omni_js_as_s16(sd)); \
  LT out = LT##_new(); \
  LT##_reserve(out, u.len); \
  for (int64_t i = 0; i < u.len; i++) { \
    out->items[i] = omni_dyn_of_real((double)(unsigned char)u.p[i]); \
  } \
  out->len = u.len; \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_iter(omni_dyn v) { \
  switch (v.tag) { \
    case OMNI_DYN_LIST: return v; \
    case OMNI_DYN_MAP: return omni_js_map_entries(v); \
    case OMNI_DYN_SET: return omni_js_set_items(v); \
    case OMNI_DYN_STR16: { \
      omni_s16 s = v.u.s16; \
      LT out = LT##_new(); \
      for (int64_t i = 0; i < s.len;) { \
        int64_t n = 1; \
        if (s.p[i] >= 0xd800 && s.p[i] <= 0xdbff && i + 1 < s.len \
            && s.p[i + 1] >= 0xdc00 && s.p[i + 1] <= 0xdfff) n = 2; \
        LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, i, i + n))); \
        i += n; \
      } \
      return omni_js_arr_wrap(out); \
    } \
    default: \
      omni_errorf("%s is not iterable", omni_dyn_tag_name(v.tag)); \
      return omni_dyn_undef(); \
  } \
} \
/* 下标是数就是元素，否则是**挂在数组身上的属性**（JS 里数组也是对象，见 omni_js_obj.h
   的旁表）。`a.foo` 与 `a["foo"]` 于是走到同一个地方 —— 降级器把成员赋值发成 idx_set。 */ \
static bool omni_js_num_key(omni_dyn k) { \
  return k.tag == OMNI_DYN_INT || k.tag == OMNI_DYN_REAL || k.tag == OMNI_DYN_UINT; \
} \
static omni_dyn omni_js_idx_get(omni_dyn o, omni_dyn k) { \
  switch (o.tag) { \
    case OMNI_DYN_LIST: \
      return omni_js_num_key(k) ? omni_js_arr_get(o, k) : omni_js_obj_get(o, k); \
    case OMNI_DYN_STR16: return omni_js_str_index(o, k); \
    case OMNI_DYN_DICT: return omni_js_obj_get(o, k); \
    case OMNI_DYN_BYTES: return omni_js_buf_get_u8(o, k); \
    default: \
      omni_errorf("cannot index a %s", omni_dyn_tag_name(o.tag)); \
      return omni_dyn_undef(); \
  } \
} \
static omni_dyn omni_js_idx_set(omni_dyn o, omni_dyn k, omni_dyn v) { \
  switch (o.tag) { \
    case OMNI_DYN_LIST: \
      if (omni_js_num_key(k)) omni_js_arr_set(o, k, v); else omni_js_obj_set(o, k, v); \
      return v; \
    case OMNI_DYN_DICT: omni_js_obj_set(o, k, v); return v; \
    case OMNI_DYN_BYTES: omni_js_buf_set_u8(o, k, v); return v; \
    default: \
      omni_errorf("cannot assign to an index of a %s", omni_dyn_tag_name(o.tag)); \
      return omni_dyn_undef(); \
  } \
} \
/* 异常对象就是普通对象：{ $cls: [类名…，最派生的在前], message }（ADR-0011 决策 15）。
   `x instanceof C` 查 $cls 链 —— 被抛出来的可以是任何值（字符串也行），所以不认的
   一律给 false，不报错。 */ \
static omni_dyn omni_js_err_new(omni_dyn msg, omni_dyn cls, omni_dyn opts) { \
  omni_dyn o = omni_js_obj_new(); \
  omni_dyn cause = omni_dyn_of_s16(omni_js_s16_lit("cause")); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("$cls")), cls); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("name")), omni_js_arr_geti(cls, 0)); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("message")), msg); \
  if (opts.tag == OMNI_DYN_DICT && omni_js_obj_has(opts, cause)) { \
    omni_js_obj_set(o, cause, omni_js_obj_get(opts, cause)); \
  } \
  return o; \
} \
static bool omni_js_is_a(omni_dyn v, omni_dyn n) { \
  if (v.tag != OMNI_DYN_DICT) return false; \
  omni_dyn c = omni_js_obj_get(v, omni_dyn_of_s16(omni_js_s16_lit("$cls"))); \
  if (c.tag != OMNI_DYN_LIST) return false; \
  LT l = omni_js_arr_of(c); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (omni_js_eq(true, l->items[i], n)) return true; \
  } \
  return false; \
}

#endif /* OMNI_JS_STR_ARR_H */
