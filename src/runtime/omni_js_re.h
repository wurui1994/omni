/* JS 的 RegExp 方法：match / split / replace（ADR-0011 的 ABI 里 js_re_* 那一段）
 *
 * 引擎本体在 omni_js_re.c；这里只有"结果要装进 list<dynamic>"或"要调回调"的那三个，
 * 它们碰容器，而 list<dynamic> 是生成 TU 里的宏实例，运行时的翻译单元看不见 ——
 * 跟 omni_js_arr.h 同一个道理。所以本文件必须在 OMNI_JS_ARR 之后展开（用它的
 * omni_js_call / omni_js_arr_wrap）。
 *
 * 三个方法的算法两侧是同一套（prelude.js 里的 $js_re_*），宿主那边也不走
 * String.prototype.replace/split —— 只借宿主 RegExp 的 exec 当匹配原语，
 * 其余（空匹配推进、$ 替换、split 的捕获组插入、limit）全自己走一遍，
 * 否则宿主实现的边角和这边一分叉就很难定位。
 *
 * 注意宏体里**每一行**都得有行尾反斜杠，注释行也要（反斜杠续行发生在删注释之前），
 * 所以解释一律写在 #define 外面。
 */
#ifndef OMNI_JS_RE_H
#define OMNI_JS_RE_H

/* omni_js_re_sub：替换串里的 $ 记号，照 ECMA-262 的 GetSubstitution。
   $$ -> $，$& -> 整个匹配，$` -> 匹配之前，$' -> 匹配之后，$n / $nn -> 第 n 组
   （越界就原样留着，JS 就是这么处理的）。 */
#define OMNI_JS_RE(LT, DT) \
static omni_s16 omni_js_re_grp(omni_s16 s, const int64_t *caps, int i) { \
  if (caps[2 * i] < 0) { omni_s16 e; e.p = s.p; e.len = 0; return e; } \
  return omni_s16_slice(s, caps[2 * i], caps[2 * i + 1]); \
} \
static omni_dyn omni_js_re_result(omni_re re, omni_s16 s, const int64_t *caps) { \
  int ng = omni_re_groups(re); \
  bool named = false; \
  LT out = LT##_new(); \
  omni_dyn arr; \
  LT##_reserve(out, ng + 1); \
  out->items[0] = omni_dyn_of_s16(omni_s16_slice(s, caps[0], caps[1])); \
  for (int i = 1; i <= ng; i++) { \
    out->items[i] = caps[2 * i] < 0 ? omni_dyn_undef() \
                                    : omni_dyn_of_s16(omni_s16_slice(s, caps[2 * i], caps[2 * i + 1])); \
  } \
  out->len = ng + 1; \
  arr = omni_js_arr_wrap(out); \
  omni_js_obj_set(arr, omni_dyn_of_s16(omni_js_s16_lit("index")), omni_dyn_of_real((double)caps[0])); \
  omni_js_obj_set(arr, omni_dyn_of_s16(omni_js_s16_lit("input")), omni_dyn_of_s16(s)); \
  for (int i = 1; i <= ng; i++) { \
    if (omni_re_group_name(re, i).p != NULL) named = true; \
  } \
  if (named) { \
    omni_dyn g = omni_js_obj_new(); \
    for (int i = 1; i <= ng; i++) { \
      omni_s16 nm = omni_re_group_name(re, i); \
      if (nm.p == NULL) continue; \
      omni_js_obj_set(g, omni_dyn_of_s16(nm), caps[2 * i] < 0 ? omni_dyn_undef() \
        : omni_dyn_of_s16(omni_s16_slice(s, caps[2 * i], caps[2 * i + 1]))); \
    } \
    omni_js_obj_set(arr, omni_dyn_of_s16(omni_js_s16_lit("groups")), g); \
  } \
  return arr; \
} \
static omni_s16 omni_js_re_sub(omni_re re, omni_s16 repl, omni_s16 s, const int64_t *caps, int ng) { \
  omni_s16_buf out = {0}; \
  for (int64_t i = 0; i < repl.len; i++) { \
    uint16_t c = repl.p[i]; \
    if (c != '$' || i + 1 >= repl.len) { omni_s16_buf_add_unit(&out, c); continue; } \
    uint16_t d = repl.p[i + 1]; \
    if (d == '$') { omni_s16_buf_add_unit(&out, '$'); i++; } \
    else if (d == '&') { omni_s16_buf_add(&out, omni_js_re_grp(s, caps, 0)); i++; } \
    else if (d == '`') { omni_s16_buf_add(&out, omni_s16_slice(s, 0, caps[0])); i++; } \
    else if (d == '\'') { omni_s16_buf_add(&out, omni_s16_slice(s, caps[1], s.len)); i++; } \
    /* $<name>：具名组（规范 22.1.3.19 表 22 的最后一行）。这个正则没有具名组时 $< 是
       普通字符 —— 与 prelude 那份的判据对着写（那边看的是 m.groups 在不在）。 */ \
    else if (d == '<' && re != NULL) { \
      int64_t end = -1; \
      bool named = false; \
      for (int gi = 1; gi <= ng; gi++) { \
        if (omni_re_group_name(re, gi).p != NULL) { named = true; break; } \
      } \
      for (int64_t j = i + 2; j < repl.len; j++) { \
        if (repl.p[j] == '>') { end = j; break; } \
      } \
      if (!named || end < 0) { omni_s16_buf_add_unit(&out, c); continue; } \
      omni_s16 want = omni_s16_slice(repl, i + 2, end); \
      for (int gi = 1; gi <= ng; gi++) { \
        omni_s16 nm = omni_re_group_name(re, gi); \
        if (nm.p != NULL && omni_s16_eq(nm, want)) { \
          omni_s16_buf_add(&out, omni_js_re_grp(s, caps, gi)); \
          break; \
        } \
      } \
      i = end; \
    } \
    else if (d >= '0' && d <= '9') { \
      int n = d - '0', used = 1; \
      if (i + 2 < repl.len && repl.p[i + 2] >= '0' && repl.p[i + 2] <= '9' \
          && n * 10 + (repl.p[i + 2] - '0') <= ng) { \
        n = n * 10 + (repl.p[i + 2] - '0'); \
        used = 2; \
      } \
      if (n >= 1 && n <= ng) { omni_s16_buf_add(&out, omni_js_re_grp(s, caps, n)); i += used; } \
      else omni_s16_buf_add_unit(&out, c); \
    } \
    else omni_s16_buf_add_unit(&out, c); \
  } \
  return omni_s16_buf_done(&out); \
} \
static omni_dyn omni_js_re_call(omni_dyn f, omni_s16 s, const int64_t *caps, int ng) { \
  LT args = LT##_new(); \
  LT##_reserve(args, ng + 3); \
  args->items[0] = omni_dyn_of_s16(omni_js_re_grp(s, caps, 0)); \
  for (int i = 1; i <= ng; i++) { \
    args->items[i] = caps[2 * i] < 0 ? omni_dyn_undef() \
                                     : omni_dyn_of_s16(omni_s16_slice(s, caps[2 * i], caps[2 * i + 1])); \
  } \
  args->items[ng + 1] = omni_dyn_of_real((double)caps[0]); \
  args->items[ng + 2] = omni_dyn_of_s16(s); \
  args->len = ng + 3; \
  return omni_js_call(f, args); \
} \
OMNI_JS_RE_2(LT, DT)

/* 第二段：三个方法本体。
   全局匹配的空匹配推进规则两侧必须一样：匹配到空串时下一次从 end+1 找，
   跳过的那个码元由"下一段原文"自然带出来，不需要单独补。 */
#define OMNI_JS_RE_2(LT, DT) \
static omni_dyn omni_js_re_replace(omni_dyn pat, omni_dyn flags, omni_dyn sd, omni_dyn repl) { \
  omni_re re = omni_js_re_get(pat, flags); \
  omni_s16 s = omni_js_as_s16(sd); \
  int ng = omni_re_groups(re); \
  bool g = omni_re_global(re); \
  int64_t caps[2 * OMNI_RE_MAX_CAPS]; \
  omni_s16_buf out = {0}; \
  int64_t at = 0, copied = 0; \
  while (at <= s.len) { \
    if (!omni_re_search(re, s, at, caps)) break; \
    omni_s16_buf_add(&out, omni_s16_slice(s, copied, caps[0])); \
    if (repl.tag == OMNI_DYN_FN) { \
      omni_dyn r = omni_js_re_call(repl, s, caps, ng); \
      omni_s16_buf_add(&out, omni_js_as_s16(omni_js_str(r))); \
    } else { \
      omni_s16_buf_add(&out, omni_js_re_sub(re, omni_js_as_s16(repl), s, caps, ng)); \
    } \
    copied = caps[1]; \
    at = caps[1] > caps[0] ? caps[1] : caps[1] + 1; \
    if (!g) break; \
  } \
  omni_s16_buf_add(&out, omni_s16_slice(s, copied, s.len)); \
  return omni_dyn_of_s16(omni_s16_buf_done(&out)); \
} \
static omni_dyn omni_js_re_match(omni_dyn pat, omni_dyn flags, omni_dyn sd) { \
  omni_re re = omni_js_re_get(pat, flags); \
  omni_s16 s = omni_js_as_s16(sd); \
  int64_t caps[2 * OMNI_RE_MAX_CAPS]; \
  LT out; \
  int64_t at = 0; \
  if (!omni_re_global(re)) { \
    if (!omni_re_search(re, s, 0, caps)) return omni_dyn_null(); \
    return omni_js_re_result(re, s, caps); \
  } \
  out = LT##_new(); \
  while (at <= s.len && omni_re_search(re, s, at, caps)) { \
    LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, caps[0], caps[1]))); \
    at = caps[1] > caps[0] ? caps[1] : caps[1] + 1; \
  } \
  return out->len == 0 ? omni_dyn_null() : omni_js_arr_wrap(out); \
} \
OMNI_JS_RE_3(LT, DT)

/* 第三段：split。照 ECMA-262 22.1.3.23 —— 捕获组要插进结果里，limit 是上界（不是段数
   目标），空串输入只在整体匹配得上时才返回空数组，末尾那段总要补上。
   空匹配不许停在当前段的起点（否则 /x*​/ 会切出无穷多个空串），所以 q 从 p 起逐位试。 */
#define OMNI_JS_RE_3(LT, DT) \
static omni_dyn omni_js_re_split(omni_dyn pat, omni_dyn flags, omni_dyn sd, omni_dyn limit) { \
  omni_re re = omni_js_re_get(pat, flags); \
  omni_s16 s = omni_js_as_s16(sd); \
  int ng = omni_re_groups(re); \
  int64_t caps[2 * OMNI_RE_MAX_CAPS]; \
  int64_t lim = INT64_MAX; \
  if (limit.tag == OMNI_DYN_REAL) { \
    if (isnan(limit.u.r) || limit.u.r < 0) lim = 0; \
    else if (limit.u.r < 9.2233720368547758e18) lim = (int64_t)limit.u.r; \
  } else if (limit.tag != OMNI_DYN_UNDEF) { \
    omni_errorf("split limit must be a number, found %s", omni_dyn_tag_name(limit.tag)); \
  } \
  LT out = LT##_new(); \
  if (lim == 0) return omni_js_arr_wrap(out); \
  if (s.len == 0) { \
    if (!omni_re_search(re, s, 0, caps)) LT##_push(out, omni_dyn_of_s16(s)); \
    return omni_js_arr_wrap(out); \
  } \
  int64_t p = 0, q = 0; \
  while (q < s.len) { \
    if (!omni_re_search(re, s, q, caps)) break; \
    int64_t m = caps[0]; \
    if (m >= s.len) break; \
    int64_t e = caps[1]; \
    if (e == p) { q = m + 1; continue; } \
    LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, p, m))); \
    if (out->len >= lim) return omni_js_arr_wrap(out); \
    for (int i = 1; i <= ng; i++) { \
      LT##_push(out, caps[2 * i] < 0 ? omni_dyn_undef() \
                                     : omni_dyn_of_s16(omni_s16_slice(s, caps[2 * i], caps[2 * i + 1]))); \
      if (out->len >= lim) return omni_js_arr_wrap(out); \
    } \
    p = e; \
    q = e; \
  } \
  LT##_push(out, omni_dyn_of_s16(omni_s16_slice(s, p, s.len))); \
  return omni_js_arr_wrap(out); \
} \
OMNI_JS_RE_4(LT, DT)

/* 第四段：正则对象上的 exec（ADR-0011 决策 10 的第二半）。
   照 ECMA-262 22.2.7.2：带 g 才用 lastIndex，从那里起找；找到就把 lastIndex 推到匹配的
   末尾（**不加 1** —— 空匹配在 JS 里就是停在原地，那是调用方的事，这里不许自己"修好"），
   没找到就把 lastIndex 归 0。不带 g 的一律从 0 起，也不动 lastIndex。
   结果是一格 list：整体匹配在 0，捕获组依次在后面，没参与的组是 undefined。
   **画出来的边界**：JS 的 exec 结果上还挂着 index / input，而这个值域里 list 带不了属性
   （决策 18），所以那两个取不到 —— 要用就得让 ABI 再长一格，不是悄悄给个错的。 */
#define OMNI_JS_RE_4(LT, DT) \
static omni_dyn omni_js_re_exec(omni_dyn rd, omni_dyn sd) { \
  omni_js_re_obj *r; \
  omni_re re; \
  omni_s16 s; \
  int64_t caps[2 * OMNI_RE_MAX_CAPS]; \
  int64_t at; \
  if (rd.tag != OMNI_DYN_RE) { \
    omni_errorf("%s is not a regexp", omni_dyn_tag_name(rd.tag)); \
  } \
  r = (omni_js_re_obj *)rd.u.ref; \
  re = omni_js_re_get(omni_dyn_of_s16(r->src), omni_dyn_of_s16(r->flags)); \
  s = omni_js_as_s16(sd); \
  at = omni_re_global(re) ? r->li : 0; \
  if (at < 0 || at > s.len || !omni_re_search(re, s, at, caps)) { \
    if (omni_re_global(re)) r->li = 0; \
    return omni_dyn_null(); \
  } \
  if (omni_re_global(re)) r->li = caps[1]; \
  return omni_js_re_result(re, s, caps); \
} \
static omni_js_re_obj *omni_js_re_want(omni_dyn rd) { \
  if (rd.tag != OMNI_DYN_RE) omni_errorf("%s is not a regexp", omni_dyn_tag_name(rd.tag)); \
  return (omni_js_re_obj *)rd.u.ref; \
} \
static omni_dyn omni_js_re_last_index(omni_dyn rd) { \
  return omni_dyn_of_real((double)omni_js_re_want(rd)->li); \
} \
/* source / flags：正则对象身上那两格只读属性。它们还有第二个身份 —— "把**运行期**的那一格
   实参摊成 (源, 旗标)"，那是 omni_js_str_replace 那一族早就在用的办法，match / matchAll /
   search 收非字面量正则时也走它（见 lower.js 的 regexCall）。所以非正则不报错，照规范
   ToString 当**模式**收下；undefined 当空模式。与 prelude 的那两格对着写。 */ \
static omni_dyn omni_js_re_source(omni_dyn rd) { \
  if (rd.tag != OMNI_DYN_RE) { \
    return rd.tag == OMNI_DYN_UNDEF ? omni_dyn_of_s16(omni_js_s16_lit("")) : omni_js_str(rd); \
  } \
  return omni_dyn_of_s16(omni_js_re_want(rd)->src); \
} \
static omni_dyn omni_js_re_flags(omni_dyn rd) { \
  if (rd.tag != OMNI_DYN_RE) return omni_dyn_of_s16(omni_js_s16_lit("")); \
  return omni_dyn_of_s16(omni_js_re_want(rd)->flags); \
} \
/* 正则对象上的 test：与 exec 共用那套 lastIndex 行为 */ \
static bool omni_js_re_test_o(omni_dyn rd, omni_dyn sd) { \
  return omni_js_re_exec(rd, sd).tag != OMNI_DYN_NULL; \
} \
/* search：头一处匹配的下标，找不到给 -1。不动 lastIndex（规范 22.1.3.22） */ \
static omni_dyn omni_js_re_search(omni_dyn pat, omni_dyn flags, omni_dyn sd) { \
  omni_re re = omni_js_re_get(pat, flags); \
  omni_s16 s = omni_js_as_s16(sd); \
  int64_t caps[2 * OMNI_RE_MAX_CAPS]; \
  if (!omni_re_search(re, s, 0, caps)) return omni_dyn_of_real(-1.0); \
  return omni_dyn_of_real((double)caps[0]); \
} \
static void omni_js_re_set_last_index(omni_dyn rd, omni_dyn v) { \
  omni_js_re_want(rd)->li = omni_js_arr_i(v); \
}

#endif
