/* JSON.stringify（ADR-0011 的 ABI 里 js_json_* 那一段）
 *
 * 是宏：要走 list<dynamic> 与 dict<string, dynamic>，那是生成 TU 里的实例。
 *
 * 只有 stringify，**没有 parse** —— 量过一遍，全仓库 JSON.parse 是 0 处用到。
 * ABI 是封闭的，用不到的不进来。
 *
 * 实参形态也是量出来的：绝大多数是 JSON.stringify(s) 一个实参（给字符串加引号），
 * 只有 cli.js 的 dump 用了 (v, replacer, 2) 三个实参。所以 replacer 与缩进都支持，
 * 但 replacer 只支持函数形式（数组白名单没人用）。
 *
 * BigInt 在 JS 里是 TypeError，这里也报错：源码里靠 replacer 先把 int 换成字符串，
 * 要是这边悄悄印成数字，两个后端的 dump 输出就不一样了。
 *
 * 宏体里每一行都要有行尾反斜杠，解释一律写在 #define 外面。
 */
#ifndef OMNI_JS_JSON_H
#define OMNI_JS_JSON_H

/* 转义规则照 JSON.stringify：只转 " \ 与 U+0000..U+001F，另外把落单的代理项写成
   \uXXXX（ES2019 的 well-formed JSON.stringify）。非 ASCII 不转义 —— 输出是 UTF-16，
   落盘时才转 UTF-8。 */
#define OMNI_JS_JSON(LT, DT) \
static omni_s16 omni_js_json_quote_s16(omni_s16 s) { \
  uint16_t *out = (uint16_t *)omni_alloc((size_t)(s.len * 6 + 2) * sizeof(uint16_t)); \
  int64_t n = 0; \
  out[n++] = '"'; \
  for (int64_t i = 0; i < s.len; i++) { \
    uint16_t c = s.p[i]; \
    bool lone = (c >= 0xd800 && c <= 0xdbff) \
      ? !(i + 1 < s.len && s.p[i + 1] >= 0xdc00 && s.p[i + 1] <= 0xdfff) \
      : (c >= 0xdc00 && c <= 0xdfff) \
        ? !(i > 0 && s.p[i - 1] >= 0xd800 && s.p[i - 1] <= 0xdbff) \
        : false; \
    if (c == '"' || c == '\\') { out[n++] = '\\'; out[n++] = c; } \
    else if (c == '\b') { out[n++] = '\\'; out[n++] = 'b'; } \
    else if (c == '\f') { out[n++] = '\\'; out[n++] = 'f'; } \
    else if (c == '\n') { out[n++] = '\\'; out[n++] = 'n'; } \
    else if (c == '\r') { out[n++] = '\\'; out[n++] = 'r'; } \
    else if (c == '\t') { out[n++] = '\\'; out[n++] = 't'; } \
    else if (c < 0x20 || lone) { \
      const char *hex = "0123456789abcdef"; \
      out[n++] = '\\'; out[n++] = 'u'; \
      out[n++] = (uint16_t)hex[(c >> 12) & 0xf]; \
      out[n++] = (uint16_t)hex[(c >> 8) & 0xf]; \
      out[n++] = (uint16_t)hex[(c >> 4) & 0xf]; \
      out[n++] = (uint16_t)hex[c & 0xf]; \
    } else { \
      out[n++] = c; \
    } \
  } \
  out[n++] = '"'; \
  omni_s16 r; r.p = out; r.len = n; return r; \
} \
static omni_s16 omni_js_s16_lit(const char *lit) { \
  return omni_s16_of_utf8(omni_str_fmt("%s", lit)); \
} \
OMNI_JS_JSON_2(LT, DT)

/* 第二段：递归序列化。
   "该省略"用 p == NULL 的 omni_s16 表示（undefined 与函数值在对象里省略、在数组里
   变成 null，JS 就是这么不对称的）。
   replacer 按规范调用：先对根用空字符串的键调一次，之后每个属性/元素各调一次，
   实参是 (key, value) —— key 在数组里是下标的字符串形式。 */
#define OMNI_JS_JSON_2(LT, DT) \
static omni_s16 omni_js_json_absent(void) { omni_s16 r; r.p = NULL; r.len = 0; return r; } \
static omni_s16 omni_js_json_val(omni_dyn v, omni_dyn rep, int64_t gap, int64_t depth); \
static omni_dyn omni_js_json_apply(omni_dyn rep, omni_s16 key, omni_dyn v) { \
  if (rep.tag == OMNI_DYN_UNDEF) return v; \
  LT args = LT##_new(); \
  LT##_reserve(args, 2); \
  args->items[0] = omni_dyn_of_s16(key); \
  args->items[1] = v; \
  args->len = 2; \
  return omni_js_call(rep, args); \
} \
static omni_s16 omni_js_json_nl(int64_t gap, int64_t depth) { \
  if (gap <= 0) return omni_js_s16_lit(""); \
  uint16_t *out = (uint16_t *)omni_alloc((size_t)(gap * depth + 1) * sizeof(uint16_t)); \
  int64_t n = 0; \
  out[n++] = '\n'; \
  for (int64_t i = 0; i < gap * depth; i++) out[n++] = ' '; \
  omni_s16 r; r.p = out; r.len = n; return r; \
} \
static omni_s16 omni_js_json_val(omni_dyn v, omni_dyn rep, int64_t gap, int64_t depth) { \
  switch (v.tag) { \
    case OMNI_DYN_UNDEF: case OMNI_DYN_FN: return omni_js_json_absent(); \
    case OMNI_DYN_NULL: return omni_js_s16_lit("null"); \
    case OMNI_DYN_BOOL: return omni_js_s16_lit(v.u.b ? "true" : "false"); \
    case OMNI_DYN_REAL: \
      return isfinite(v.u.r) ? omni_js_as_s16(omni_js_str(v)) : omni_js_s16_lit("null"); \
    case OMNI_DYN_STR16: return omni_js_json_quote_s16(v.u.s16); \
    case OMNI_DYN_INT: \
      omni_error("do not know how to serialize a bigint"); \
      return omni_js_json_absent(); \
    case OMNI_DYN_LIST: { \
      LT l = (LT)v.u.ref; \
      if (l->len == 0) return omni_js_s16_lit("[]"); \
      omni_s16 out = omni_js_s16_lit("["); \
      omni_s16 sep = omni_js_json_nl(gap, depth + 1); \
      for (int64_t i = 0; i < l->len; i++) { \
        if (i) out = omni_s16_cat(out, omni_js_s16_lit(",")); \
        out = omni_s16_cat(out, sep); \
        omni_dyn x = omni_js_json_apply(rep, omni_js_as_s16(omni_js_str(omni_dyn_of_real((double)i))), l->items[i]); \
        omni_s16 s = omni_js_json_val(x, rep, gap, depth + 1); \
        out = omni_s16_cat(out, s.p ? s : omni_js_s16_lit("null")); \
      } \
      out = omni_s16_cat(out, omni_js_json_nl(gap, depth)); \
      return omni_s16_cat(out, omni_js_s16_lit("]")); \
    } \
    case OMNI_DYN_DICT: { \
      DT d = (DT)v.u.ref; \
      omni_s16 out = omni_js_s16_lit("{"); \
      omni_s16 sep = omni_js_json_nl(gap, depth + 1); \
      bool first = true; \
      for (int64_t i = 0; i < d->n; i++) { \
        if (!d->live[i]) continue; \
        omni_s16 key = omni_s16_of_utf8(d->keys[i]); \
        omni_dyn x = omni_js_json_apply(rep, key, d->vals[i]); \
        omni_s16 s = omni_js_json_val(x, rep, gap, depth + 1); \
        if (!s.p) continue; \
        if (!first) out = omni_s16_cat(out, omni_js_s16_lit(",")); \
        first = false; \
        out = omni_s16_cat(out, sep); \
        out = omni_s16_cat(out, omni_js_json_quote_s16(key)); \
        out = omni_s16_cat(out, omni_js_s16_lit(gap > 0 ? ": " : ":")); \
        out = omni_s16_cat(out, s); \
      } \
      if (first) return omni_js_s16_lit("{}"); \
      out = omni_s16_cat(out, omni_js_json_nl(gap, depth)); \
      return omni_s16_cat(out, omni_js_s16_lit("}")); \
    } \
    default: \
      omni_errorf("do not know how to serialize a %s", omni_dyn_tag_name(v.tag)); \
      return omni_js_json_absent(); \
  } \
} \
static omni_dyn omni_js_json_stringify(omni_dyn v, omni_dyn rep, omni_dyn indent) { \
  int64_t gap = 0; \
  if (indent.tag == OMNI_DYN_REAL && indent.u.r > 0) { \
    gap = (int64_t)indent.u.r; \
    if (gap > 10) gap = 10; \
  } \
  omni_dyn root = omni_js_json_apply(rep, omni_js_s16_lit(""), v); \
  omni_s16 s = omni_js_json_val(root, rep, gap, 0); \
  return s.p ? omni_dyn_of_s16(s) : omni_dyn_undef(); \
}


#endif /* OMNI_JS_JSON_H */
