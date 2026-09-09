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
/* replace(串, 替换)：只换**第一处**（规范 22.1.3.19 的非全局那一支）。替换是函数就调它
   （收 (match, offset, string)），是串就走 $ 展开 —— 两样都借 omni_js_re_* 那两格
   （RE 那段比这一段先展开），caps 现搭一格 {at, at+len}、没有编号组。 */ \
/* 一处替换：是函数就调一次（收 (match, offset, string)），是串就走 $ 展开。
   replace 与 replaceAll 共用这一格 —— 判据与 prelude 里那两处的 sub() 相同。 */ \
static omni_s16 omni_js_str_rep1(omni_dyn repl, omni_s16 s, const int64_t *caps) { \
  if (repl.tag == OMNI_DYN_FN) { \
    return omni_js_as_s16(omni_js_str(omni_js_re_call(repl, s, caps, 0))); \
  } \
  return omni_js_re_sub(NULL, omni_js_as_s16(repl), s, caps, 0); \
} \
static omni_dyn omni_js_str_replace(omni_dyn sd, omni_dyn patd, omni_dyn repl) { \
  omni_s16 s, p; \
  int64_t at; \
  omni_s16_buf out = { 0, 0, 0 }; \
  int64_t caps[2]; \
  /* 运行期的正则（new RegExp(...) 存进变量再用）：转给正则那一支 */ \
  if (patd.tag == OMNI_DYN_RE) { \
    return omni_js_re_replace(omni_js_re_source(patd), omni_js_re_flags(patd), sd, repl); \
  } \
  s = omni_js_as_s16(sd); \
  p = omni_js_as_s16(patd); \
  at = omni_s16_index_of(s, p, 0); \
  if (at < 0) return omni_dyn_of_s16(s); \
  caps[0] = at; \
  caps[1] = at + p.len; \
  omni_s16_buf_add(&out, omni_s16_slice(s, 0, at)); \
  omni_s16_buf_add(&out, omni_js_str_rep1(repl, s, caps)); \
  omni_s16_buf_add(&out, omni_s16_slice(s, caps[1], s.len)); \
  return omni_dyn_of_s16(omni_s16_buf_done(&out)); \
} \
/* replaceAll（串模式）：与 replace 同一套判据，只是换**每一处**。空模式在每个码元之间
   都算一处（"abc".replaceAll("", "-") 是 "-a-b-c-"）。它从 omni_js_str.c 搬到这一段，
   为的就是能用 omni_js_re_sub / omni_js_re_call —— 从前那份把替换一律当串，函数当场
   报错、`$&` 那些被当普通字符抄过去（两处都量出来了，prelude 那边一起改的）。 */ \
static omni_dyn omni_js_str_replace_all(omni_dyn sd, omni_dyn patd, omni_dyn repl) { \
  omni_s16 s, p; \
  omni_s16_buf out = { 0, 0, 0 }; \
  int64_t caps[2]; \
  int64_t i = 0; \
  if (patd.tag == OMNI_DYN_RE) { \
    return omni_js_re_replace(omni_js_re_source(patd), omni_js_re_flags(patd), sd, repl); \
  } \
  s = omni_js_as_s16(sd); \
  p = omni_js_as_s16(patd); \
  if (p.len == 0) { \
    caps[0] = 0; \
    caps[1] = 0; \
    omni_s16_buf_add(&out, omni_js_str_rep1(repl, s, caps)); \
    for (int64_t k = 0; k < s.len; k++) { \
      omni_s16_buf_add(&out, omni_s16_slice(s, k, k + 1)); \
      caps[0] = k + 1; \
      caps[1] = k + 1; \
      omni_s16_buf_add(&out, omni_js_str_rep1(repl, s, caps)); \
    } \
    return omni_dyn_of_s16(omni_s16_buf_done(&out)); \
  } \
  for (;;) { \
    int64_t at = omni_s16_index_of(s, p, i); \
    if (at < 0) break; \
    omni_s16_buf_add(&out, omni_s16_slice(s, i, at)); \
    caps[0] = at; \
    caps[1] = at + p.len; \
    omni_s16_buf_add(&out, omni_js_str_rep1(repl, s, caps)); \
    i = at + p.len; \
  } \
  omni_s16_buf_add(&out, omni_s16_slice(s, i, s.len)); \
  return omni_dyn_of_s16(omni_s16_buf_done(&out)); \
} \
/* Array.from(v[, f])：mapFn 收 (value, index)（规范 23.1.2.1 —— 只有两格，所以不能用
   固定三格的 omni_js_call3）。**类数组**（dict 上有 length）也认：按 0..length-1 取下标，
   那是 Array.from({length:n}, f) 的用法。它落在这一段是因为要 omni_js_obj_get 与
   omni_js_s16_lit，那两格分别在 obj / json 那两段里，都比 arr 那段后展开。 */ \
static omni_dyn omni_js_arr_from(omni_dyn v, omni_dyn f) { \
  LT out = LT##_new(); \
  LT l; \
  omni_dyn src = v; \
  /* 先把源头摊成一格 list —— 串按**码点**（与 prelude 那份的 [...s] 一致）、Map/Set 给
     条目、类数组（dict 上有 length）按 0..length-1 取下标。 */ \
  if (v.tag == OMNI_DYN_STR16) { \
    omni_s16 s = omni_js_as_s16(v); \
    LT cps = LT##_new(); \
    for (int64_t i = 0; i < s.len; ) { \
      int64_t w = (s.p[i] >= 0xD800 && s.p[i] <= 0xDBFF && i + 1 < s.len \
                   && s.p[i + 1] >= 0xDC00 && s.p[i + 1] <= 0xDFFF) ? 2 : 1; \
      LT##_push(cps, omni_dyn_of_s16(omni_s16_slice(s, i, i + w))); \
      i += w; \
    } \
    src = omni_js_arr_wrap(cps); \
  } else if (v.tag == OMNI_DYN_MAP) { \
    src = omni_js_map_entries(v); \
  } else if (v.tag == OMNI_DYN_SET) { \
    src = omni_js_set_items(v); \
  } else if (v.tag == OMNI_DYN_BYTES) { \
    /* Uint8Array：一格一个字节的数（omni_js_iter 那一支在这一段之后才定义，所以这儿
       自己摊一遍，与它一字一句对着写） */ \
    int64_t bn = omni_js_arr_i(omni_js_buf_len(v)); \
    LT bl = LT##_new(); \
    LT##_reserve(bl, bn); \
    for (int64_t i = 0; i < bn; i++) { \
      bl->items[bl->len++] = omni_js_buf_get_u8(v, omni_dyn_of_real((double)i)); \
    } \
    src = omni_js_arr_wrap(bl); \
  } else if (v.tag == OMNI_DYN_DICT) { \
    omni_dyn n = omni_js_obj_get(v, omni_dyn_of_s16(omni_js_s16_lit("length"))); \
    int64_t k = (n.tag == OMNI_DYN_UNDEF) ? 0 : omni_js_arr_i(n); \
    LT al = LT##_new(); \
    for (int64_t i = 0; i < k; i++) { \
      LT##_push(al, omni_js_obj_get(v, omni_js_str(omni_dyn_of_real((double)i)))); \
    } \
    src = omni_js_arr_wrap(al); \
  } \
  if (f.tag == OMNI_DYN_UNDEF) return omni_js_arr_slice(src, omni_dyn_undef(), omni_dyn_undef()); \
  l = omni_js_arr_of(src); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) { \
    const omni_dyn tmp[2] = { l->items[i], omni_dyn_of_real((double)i) }; \
    LT##_push(out, omni_js_call(f, LT##_from(tmp, 2))); \
  } \
  return omni_js_arr_wrap(out); \
} \
/* substring：两头都夹到 [0, len]，start > end 就换过来（规范 22.1.3.24）——
   与 slice 的差别是它**不认负下标**（负的一律当 0）。 */ \
static omni_dyn omni_js_str_substring(omni_dyn sd, omni_dyn ad, omni_dyn bd) { \
  omni_s16 v = omni_js_as_s16(sd); \
  int64_t a = (ad.tag == OMNI_DYN_UNDEF) ? 0 : omni_js_arr_i(ad); \
  int64_t b = (bd.tag == OMNI_DYN_UNDEF) ? v.len : omni_js_arr_i(bd); \
  int64_t t; \
  if (a < 0) a = 0; \
  if (a > v.len) a = v.len; \
  if (b < 0) b = 0; \
  if (b > v.len) b = v.len; \
  if (a > b) { t = a; a = b; b = t; } \
  return omni_dyn_of_s16(omni_s16_slice(v, a, b)); \
} \
static omni_dyn omni_js_str_split(omni_dyn sd, omni_dyn sepd, omni_dyn limitd) { \
  omni_s16 s = omni_js_as_s16(sd); \
  LT out = LT##_new(); \
  /* 分隔符不给：整串就是一格（规范 22.1.3.23 第 3 步） */ \
  if (sepd.tag == OMNI_DYN_UNDEF) { \
    LT##_push(out, omni_dyn_of_s16(s)); \
    return omni_js_arr_wrap(out); \
  } \
  /* 运行期的正则（new RegExp(...) 存进变量再用）：转给正则那一支，与 replace 同办法 */ \
  if (sepd.tag == OMNI_DYN_RE) { \
    return omni_js_re_split(omni_js_re_source(sepd), omni_js_re_flags(sepd), sd, limitd); \
  } \
  omni_s16 sep = omni_js_as_s16(sepd); \
  /* limit 是结果长度的**上界**（规范 22.1.3.23）；缺席或负数就是不限 */ \
  int64_t lim = (limitd.tag == OMNI_DYN_UNDEF) ? -1 : omni_js_arr_i(limitd); \
  if (lim == 0) return omni_js_arr_wrap(out); \
  if (sep.len == 0) { \
    for (int64_t i = 0; i < s.len; i++) { \
      if (lim > 0 && out->len >= lim) return omni_js_arr_wrap(out); \
      LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, i, i + 1))); \
    } \
    return omni_js_arr_wrap(out); \
  } \
  int64_t p = 0; \
  for (;;) { \
    int64_t at = omni_s16_index_of(s, sep, p); \
    if (at < 0) break; \
    LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, p, at))); \
    if (lim > 0 && out->len >= lim) return omni_js_arr_wrap(out); \
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
/* 一格能 catch 的 TypeError（异常对象就是 { $cls: […], name, message }，ADR-0011 决策 15）。声明在 ARR 那一段。
   摆在 omni_js_iter 前面：那儿要用它，而 omni_js_err_new 在这个文件里排得更后。 */ \
static void omni_js_type_err_c(const char *msg) { \
  LT cls = LT##_new(); \
  LT##_push(cls, omni_dyn_of_s16(omni_js_s16_lit("TypeError"))); \
  LT##_push(cls, omni_dyn_of_s16(omni_js_s16_lit("Error"))); \
  omni_dyn o = omni_js_obj_new(); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("$cls")), omni_js_arr_wrap(cls)); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("name")), omni_dyn_of_s16(omni_js_s16_lit("TypeError"))); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("message")), omni_dyn_of_s16(omni_js_s16_lit(msg))); \
  omni_js_throw(o); \
} \
static void omni_js_range_err_c(const char *msg) { \
  LT cls = LT##_new(); \
  LT##_push(cls, omni_dyn_of_s16(omni_js_s16_lit("RangeError"))); \
  LT##_push(cls, omni_dyn_of_s16(omni_js_s16_lit("Error"))); \
  omni_dyn o = omni_js_obj_new(); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("$cls")), omni_js_arr_wrap(cls)); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("name")), omni_dyn_of_s16(omni_js_s16_lit("RangeError"))); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("message")), omni_dyn_of_s16(omni_js_s16_lit(msg))); \
  omni_js_throw(o); \
} \
static omni_dyn omni_js_iter(omni_dyn v) { \
  switch (v.tag) { \
    case OMNI_DYN_LIST: return v; \
    case OMNI_DYN_MAP: return omni_js_map_entries(v); \
    case OMNI_DYN_SET: return omni_js_set_items(v); \
    /* Uint8Array 也可迭代（[...u8] / for-of / Array.from）：一格一个字节的数 */ \
    case OMNI_DYN_BYTES: { \
      LT out = LT##_new(); \
      int64_t n = omni_js_arr_i(omni_js_buf_len(v)); \
      LT##_reserve(out, n); \
      for (int64_t i = 0; i < n; i++) { \
        out->items[out->len++] = omni_js_buf_get_u8(v, omni_dyn_of_real((double)i)); \
      } \
      return omni_js_arr_wrap(out); \
    } \
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
      /* 不可迭代（规范 7.4.2 的 GetIterator）是 TypeError，**能 catch** —— `[...null]` 与
         `for (const x of 5)` 两把尺子上都是 catch 得住的。从前是硬错，进程就停在那儿。
         报过之后交一格空表回去：调用点（js_iter_open 那一族都带 throws）紧跟的 pending
         检查会接着退，中间这一格不会被真的用到。 */ \
      omni_js_type_err_c("value is not iterable"); \
      return omni_js_arr_wrap(LT##_new()); \
  } \
} \
/* for-of 的惰性形态（ADR-0020）：C 这侧只有 list 那一支 —— 真迭代器（生成器、带
   Symbol.iterator 的对象）是 JS 那条腿独有的，走到这儿本来就是 "not iterable"。
   所以把手就是那个 list，done 只是比下标，close 是空操作。 */ \
static omni_dyn omni_js_iter_open(omni_dyn v) { return omni_js_iter(v); } \
static bool omni_js_iter_done(omni_dyn h, omni_dyn i) { \
  return omni_js_arr_i(i) >= omni_js_arr_of(h)->len; \
} \
static omni_dyn omni_js_iter_cur(omni_dyn h, omni_dyn i) { return omni_js_arr_at(h, i); } \
static void omni_js_iter_close(omni_dyn h) { (void)h; } \
static omni_dyn omni_js_iter_rest(omni_dyn h, omni_dyn i) { \
  return omni_js_arr_slice(h, i, omni_dyn_undef()); \
} \
/* String.raw 的**普通调用**形态（tag 形态在降级器那儿就折成字面量了）：段数看 raw.length，
   最后一段后面不再拼插值；插值不够就当没有，不是拼 "undefined"。 */ \
static omni_dyn omni_js_str_raw(omni_dyn strs, omni_dyn subs) { \
  omni_dyn raw = omni_js_obj_get(strs, omni_dyn_of_s16(omni_js_s16_lit("raw"))); \
  LT l = omni_js_arr_of(raw); \
  LT vs = omni_js_arr_of(subs); \
  omni_s16 out = omni_s16_of_utf8(omni_str_new("", 0)); \
  for (int64_t i = 0; i < l->len; i++) { \
    out = omni_s16_cat(out, omni_js_as_s16(omni_js_str(l->items[i]))); \
    if (i + 1 < l->len && i < vs->len) out = omni_s16_cat(out, omni_js_as_s16(omni_js_str(vs->items[i]))); \
  } \
  return omni_dyn_of_s16(out); \
} \
/* Uint8Array 上那几格数组方法：先摊成字节的数组（omni_js_iter），再走 list 那一格。
   只有**结果是原始值**的四格 —— map / filter / slice 在 JS 里交出 TypedArray，
   摊成 list 会在打印与 JSON 上撒谎，所以那几个照旧当场报错。 */ \
static omni_dyn omni_js_buf_join(omni_dyn b, omni_dyn sep) { \
  return omni_js_arr_join(omni_js_iter(b), sep); \
} \
static omni_dyn omni_js_buf_elem_at(omni_dyn b, omni_dyn i) { \
  return omni_js_arr_at(omni_js_iter(b), i); \
} \
static omni_dyn omni_js_buf_index_of(omni_dyn b, omni_dyn v) { \
  return omni_js_arr_index_of(omni_js_iter(b), v, omni_dyn_undef()); \
} \
static bool omni_js_buf_includes(omni_dyn b, omni_dyn v) { \
  return omni_js_arr_includes(omni_js_iter(b), v, omni_dyn_undef()); \
} \
/* 下标是**规范的数组下标**（非负整数）就是元素，否则是**挂在数组身上的属性**
   （JS 里数组也是对象，见 omni_js_obj.h 的旁表）。`a.foo` 与 `a["foo"]` 于是走到同一个
   地方 —— 降级器把成员赋值发成 idx_set。负数与带小数的也走属性那一支（规范 10.4.2.1 的
   CanonicalNumericIndexString）：a[-1] = 7 不动 length，从前撞在 "negative array index"
   上。与 prelude 的 $js_num_key 对着写。 */ \
static bool omni_js_num_key(omni_dyn k) { \
  double d; \
  if (k.tag == OMNI_DYN_UINT) return true; \
  if (k.tag != OMNI_DYN_INT && k.tag != OMNI_DYN_REAL) return false; \
  d = (k.tag == OMNI_DYN_INT) ? (double)k.u.i : k.u.r; \
  return d >= 0.0 && d == trunc(d); \
} \
static omni_dyn omni_js_idx_get(omni_dyn o, omni_dyn k) { \
  switch (o.tag) { \
    case OMNI_DYN_LIST: \
      return omni_js_num_key(k) ? omni_js_arr_get(o, k) : omni_js_obj_get(o, k); \
    case OMNI_DYN_STR16: return omni_js_str_index(o, k); \
    case OMNI_DYN_DICT: return omni_js_obj_get(o, k); \
    case OMNI_DYN_BYTES: return omni_js_buf_get_u8(o, k); \
    default: \
      /* null / undefined 上的 o[k]：能 catch 的 TypeError。算出来的键这条路 qjs 不把键
         印进消息（量过：null[0] 是 "cannot read property of null"）—— 照它走。 */ \
      if (o.tag == OMNI_DYN_NULL || o.tag == OMNI_DYN_UNDEF) { \
        omni_js_nullish_err_("cannot read", omni_str_new("", 0), false, o); \
        return omni_dyn_undef(); \
      } \
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
    case OMNI_DYN_RE: { \
      if (!omni_s16_eq(omni_js_as_s16(omni_js_str(k)), omni_js_s16_lit("lastIndex"))) { \
        omni_errorf("cannot assign to '%s' of a regexp", omni_cstr(omni_s16_to_utf8(omni_js_as_s16(omni_js_str(k))))); \
      } \
      omni_js_re_set_last_index(o, v); \
      return v; \
    } \
    default: \
      /* null / undefined 上的 o[k] = v：能 catch 的 TypeError，键印在消息里
         （量过 qjs：u[1] = 2 那句是 "cannot set property '1' of undefined"）。 */ \
      if (o.tag == OMNI_DYN_NULL || o.tag == OMNI_DYN_UNDEF) { \
        omni_js_nullish_err_("cannot set", omni_s16_to_utf8(omni_js_as_s16(omni_js_str(k))), true, o); \
        return v; \
      } \
      omni_errorf("cannot assign to an index of a %s", omni_dyn_tag_name(o.tag)); \
      return omni_dyn_undef(); \
  } \
} \
/* Object.fromEntries（规范 20.1.2.7）：把一串 [k, v] 摊成一格对象。JS 那条腿上造的是
   真对象（$JSObj + Object.prototype），这条腿上"普通对象"就是 dict —— 键都过一遍
   ToPropertyKey、值原样存，可观察的那几样（取键、Object.keys、JSON）逐格相同。 */ \
static omni_dyn omni_js_obj_from_entries(omni_dyn pairs) { \
  omni_dyn o = omni_js_obj_new(); \
  LT xs = omni_js_arr_of(omni_js_iter(pairs)); \
  for (int64_t i = 0; i < xs->len; i++) { \
    omni_dyn p = xs->items[i]; \
    /* 键过一遍 ToPropertyKey：符号原样，别的**一律转串**（`[[true,"b"]]` 的键是 "true"）。
       不能直接交给 omni_js_obj_set —— 那条路上的 omni_js_prop_k 只把数转串，别的标签
       撞在 "bool is not a string" 上（量出来的）。那句断言是"降级发错了"的固定签名，
       不该被这一族正常写法碰上，所以在这儿先规范化。 */ \
    omni_dyn k = omni_js_idx_get(p, omni_dyn_of_real(0.0)); \
    omni_js_obj_set(o, k.tag == OMNI_DYN_SYM ? k : omni_js_str(k), \
                       omni_js_idx_get(p, omni_dyn_of_real(1.0))); \
  } \
  return o; \
} \
/* Object.hasOwn / Reflect.has / Reflect.deleteProperty 那三格。JS 那条腿上它们先问真对象的
   槽表、再走原型链或代理陷阱；这条腿上"普通对象"是 dict、数组是一段 items —— 自有键就是
   全部键（没有原型链），所以三格都落回容器那一套。
   刻意保留 omni_js_obj_get 的那句响错：Map / 原始值上取表外成员在这条腿上还没有落点，
   给 false 会把"原型上确实有的名字"悄悄答成没有。 */ \
static bool omni_js_obj_has_own(omni_dyn o, omni_dyn k) { \
  if (o.tag == OMNI_DYN_LIST || o.tag == OMNI_DYN_DICT) return omni_js_obj_has(o, k); \
  /* 串上的下标与 length 也是**自有**属性（规范 10.4.3） */ \
  if (o.tag == OMNI_DYN_STR16) { \
    omni_str key = omni_js_prop_k(k); \
    if (key.len == 6 && memcmp(key.p, "length", 6) == 0) return true; \
    int64_t idx = omni_js_dec_index(key); \
    return idx >= 0 && idx < o.u.s16.len; \
  } \
  return false; \
} \
static bool omni_js_obj_has_p(omni_dyn o, omni_dyn k) { \
  if (o.tag == OMNI_DYN_LIST || o.tag == OMNI_DYN_DICT || o.tag == OMNI_DYN_STR16) { \
    return omni_js_obj_has_own(o, k); \
  } \
  return omni_js_obj_get(o, k).tag != OMNI_DYN_UNDEF; \
} \
static bool omni_js_obj_del_p(omni_dyn o, omni_dyn k) { \
  if (o.tag == OMNI_DYN_LIST || o.tag == OMNI_DYN_DICT) { \
    /* 没有那一格时规范交 true（21.1.3.5 的 [[Delete]]："删不掉"才是 false） */ \
    if (!omni_js_obj_has(o, k)) return true; \
    return omni_js_obj_delete(o, k); \
  } \
  return true; \
} \
/* 属性描述符（规范 6.2.6）。这条腿上"普通对象"是 dict、数组是一段 items —— 都**没有
   属性位**（没有访问器、没有不可写／不可枚举的自有槽），所以描述符只能是照实合成的那一格：
   数据属性、三个位按值域算。三档锁是唯一能把位改掉的东西（冻住 → 不可写、不可配置；
   封住 → 不可配置），所以那两张表要问一句。
   数组与字符串照规范 10.4.2.1：下标是可写／可枚举／可配置的数据属性（字符串上是只读、
   不可配置），length 可写但**不可枚举、不可配置**（字符串上连写都不行）。
   Object.defineProperty 那一格**照旧拒**：`{ value: 1 }` 在规范里造的是不可枚举、不可写、
   不可配置的属性，而 dict 表达不出来 —— 收下就是悄悄的错答案。 */ \
static omni_dyn omni_js_desc_mk_(omni_dyn v, bool w, bool e, bool c) { \
  omni_dyn d = omni_js_obj_new(); \
  omni_js_obj_set(d, omni_dyn_of_s16(omni_js_s16_lit("value")), v); \
  omni_js_obj_set(d, omni_dyn_of_s16(omni_js_s16_lit("writable")), omni_dyn_of_bool(w)); \
  omni_js_obj_set(d, omni_dyn_of_s16(omni_js_s16_lit("enumerable")), omni_dyn_of_bool(e)); \
  omni_js_obj_set(d, omni_dyn_of_s16(omni_js_s16_lit("configurable")), omni_dyn_of_bool(c)); \
  return d; \
} \
static omni_dyn omni_js_obj_desc(omni_dyn o, omni_dyn k) { \
  omni_str key = omni_js_prop_k(k); \
  bool w = !omni_js_frozen_(o); \
  bool c = !omni_js_lk_has_(omni_js_sealed_tbl_, o); \
  bool len_key = key.len == 6 && memcmp(key.p, "length", 6) == 0; \
  int64_t idx = omni_js_dec_index(key); \
  if (o.tag == OMNI_DYN_STR16) { \
    omni_s16 s = o.u.s16; \
    if (len_key) return omni_js_desc_mk_(omni_dyn_of_real((double)s.len), false, false, false); \
    if (idx >= 0 && idx < s.len) { \
      return omni_js_desc_mk_(omni_dyn_of_s16(omni_s16_slice(s, idx, idx + 1)), false, true, false); \
    } \
    return omni_dyn_undef(); \
  } \
  if (o.tag == OMNI_DYN_LIST) { \
    LT l = (LT)o.u.ref; \
    if (len_key) return omni_js_desc_mk_(omni_dyn_of_real((double)l->len), w, false, false); \
    if (idx >= 0) { \
      if (idx >= l->len) return omni_dyn_undef(); \
      return omni_js_desc_mk_(l->items[idx], w, true, c); \
    } \
    DT x = omni_js_xprops_(o, false); \
    int64_t e = x == NULL ? -1 : DT##_find(x, key); \
    if (e < 0) return omni_dyn_undef(); \
    return omni_js_desc_mk_(x->vals[e], w, true, c); \
  } \
  if (o.tag == OMNI_DYN_DICT) { \
    DT d = omni_js_dict_of(o); \
    int64_t e = DT##_find(d, key); \
    if (e < 0) return omni_dyn_undef(); \
    return omni_js_desc_mk_(d->vals[e], w, true, c); \
  } \
  return omni_dyn_undef(); \
} \
/* Object.getOwnPropertyNames / Reflect.ownKeys 那一格。sel 是编译期的一个字符：
   's' 要字符串键（含不可枚举的 length）、'e' 只要可枚举的、'y' 只要符号键 ——
   这条腿上没有符号键的自有槽，所以 'y' 一律是空表。与 prelude 的 $js_obj_own_keys 对着写。 */ \
static omni_dyn omni_js_obj_own_keys(int sel, omni_dyn o) { \
  if (sel == 'y') return omni_js_arr_wrap(LT##_new()); \
  if (sel == 'e') return omni_js_obj_keys(o); \
  if (o.tag == OMNI_DYN_LIST) { \
    LT out = omni_js_arr_of(omni_js_arr_own_keys(o)); \
    LT ks = LT##_new(); \
    int64_t n = ((LT)o.u.ref)->len; \
    for (int64_t i = 0; i < n; i++) LT##_push(ks, out->items[i]); \
    LT##_push(ks, omni_dyn_of_s16(omni_js_s16_lit("length"))); \
    for (int64_t i = n; i < out->len; i++) LT##_push(ks, out->items[i]); \
    return omni_js_arr_wrap(ks); \
  } \
  if (o.tag == OMNI_DYN_STR16) { \
    LT ks = omni_js_arr_of(omni_js_str_idx_keys(o.u.s16)); \
    LT##_push(ks, omni_dyn_of_s16(omni_js_s16_lit("length"))); \
    return omni_js_arr_wrap(ks); \
  } \
  return omni_js_obj_keys(o); \
} \
/* Object.getOwnPropertyDescriptors：每个自有键一格描述符 */ \
static omni_dyn omni_js_obj_descs(omni_dyn o) { \
  omni_dyn out = omni_js_obj_new(); \
  LT ks = omni_js_arr_of(omni_js_obj_own_keys('s', o)); \
  for (int64_t i = 0; i < ks->len; i++) { \
    omni_js_obj_set(out, ks->items[i], omni_js_obj_desc(o, ks->items[i])); \
  } \
  return out; \
} \
/* Object.groupBy（ES2024）：走一遍迭代，回调收 (value, index)，每组按**原顺序**攒成一个
   数组。规范说交出来的是一格 null 原型的对象 —— 这条腿上没有原型链，dict 就是那格对象
   （`Object.getPrototypeOf` 本来就还在 P1_JS_ONLY 里，问不着）。键照规范过 ToPropertyKey：
   符号原样、别的转串。回调每调一次都要问一句待决错误，不然抛了还接着分组。 */ \
static omni_dyn omni_js_obj_group_by(omni_dyn items, omni_dyn f) { \
  omni_dyn out = omni_js_obj_new(); \
  LT xs = omni_js_arr_of(omni_js_iter(items)); \
  for (int64_t i = 0; i < xs->len; i++) { \
    const omni_dyn tmp[2] = { xs->items[i], omni_dyn_of_real((double)i) }; \
    omni_dyn kv = omni_js_call(f, LT##_from(tmp, 2)); \
    if (omni_js_pending()) return out; \
    omni_dyn k = kv.tag == OMNI_DYN_SYM ? kv : omni_js_str(kv); \
    omni_dyn g = omni_js_obj_get(out, k); \
    if (g.tag != OMNI_DYN_LIST) { \
      g = omni_js_arr_wrap(LT##_new()); \
      omni_js_obj_set(out, k, g); \
    } \
    LT##_push((LT)g.u.ref, xs->items[i]); \
  } \
  return out; \
} \
/* 异常对象就是普通对象：{ $cls: [类名…，最派生的在前], message }（ADR-0011 决策 15）。
   `x instanceof C` 查 $cls 链 —— 被抛出来的可以是任何值（字符串也行），所以不认的
   一律给 false，不报错。 */ \
static omni_dyn omni_js_err_new(omni_dyn msg, omni_dyn cls, omni_dyn opts) { \
  omni_dyn o = omni_js_obj_new(); \
  omni_dyn cause = omni_dyn_of_s16(omni_js_s16_lit("cause")); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("$cls")), cls); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("name")), omni_js_arr_geti(cls, 0)); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("message")), \
    msg.tag == OMNI_DYN_UNDEF ? omni_dyn_of_s16(omni_js_s16_lit("")) : msg); \
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
