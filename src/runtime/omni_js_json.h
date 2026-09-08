/* JSON.stringify（ADR-0011 的 ABI 里 js_json_* 那一段）
 *
 * 是宏：要走 list<dynamic> 与 dict<string, dynamic>，那是生成 TU 里的实例。
 *
 * stringify 与 parse 两半都在（第三段是 parse）。parse 从前不在表里 —— 那时量到 0 处
 * 用到；asy 的接口索引把 .aif 读回来之后 cli.js:792 有一处，封闭的 ABI 就该长一格。
 *
 * 实参形态也是量出来的：绝大多数是 JSON.stringify(s) 一个实参（给字符串加引号）， * 只有 cli.js 的 dump 用了 (v, replacer, 2) 三个实参。所以 replacer 与缩进都支持，
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
  if (v.tag == OMNI_DYN_DICT) { \
    omni_dyn tj = omni_js_obj_get(v, omni_dyn_of_s16(omni_js_s16_lit("toJSON"))); \
    if (tj.tag == OMNI_DYN_FN) { \
      LT noargs = LT##_new(); \
      v = omni_js_call_this(tj, v, omni_js_arr_wrap(noargs)); \
    } \
  } \
  switch (v.tag) { \
    case OMNI_DYN_UNDEF: case OMNI_DYN_FN: return omni_js_json_absent(); \
    case OMNI_DYN_NULL: return omni_js_s16_lit("null"); \
    case OMNI_DYN_BOOL: return omni_js_s16_lit(v.u.b ? "true" : "false"); \
    case OMNI_DYN_REAL: \
      return isfinite(v.u.r) ? omni_js_as_s16(omni_js_str(v)) : omni_js_s16_lit("null"); \
    case OMNI_DYN_STR16: return omni_js_json_quote_s16(v.u.s16); \
    case OMNI_DYN_INT: case OMNI_DYN_UINT: \
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
    case OMNI_DYN_MAP: case OMNI_DYN_SET: return omni_js_s16_lit("{}"); \
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
} \
OMNI_JS_JSON_3(LT, DT)

/* 第三段：JSON.parse。与 backend-js/prelude.js 里的 $js_json_* 是同一套算法 ——
   两边都按 UTF-16 码元扫，所以报错里的 "position N" 一定是同一个数；文本也逐字相同。

   只认 RFC 8259 那一份：不收注释、单引号、尾逗号、NaN/Infinity。数一律出 real
   （宿主 JSON.parse 也没有 BigInt 那一支）。重复的键后来的赢、位置留在第一次出现的
   地方 —— dict_set 与 JS 侧 Map.set 都是这个语义。没有 reviver。

   解析失败是硬错（omni: runtime error），不是能 catch 的 SyntaxError：ADR-0007
   决定 1 里 throw 是静态降级的，而这个 op 里没有用户回调可以往 pending 槽里放东西。 */
#define OMNI_JS_JSON_3(LT, DT) \
typedef struct { const uint16_t *p; int64_t len; int64_t i; } omni_js_json_cur; \
static OMNI_NORETURN void omni_js_json_eoi(void) { \
  omni_error("unexpected end of JSON input"); \
} \
static OMNI_NORETURN void omni_js_json_bad(omni_js_json_cur *z) { \
  uint16_t c = z->p[z->i]; \
  if (c >= 0x20 && c < 0x7f) { \
    omni_errorf("unexpected token '%c' in JSON at position %lld", (char)c, (long long)z->i); \
  } \
  omni_errorf("unexpected token \\u%04x in JSON at position %lld", (unsigned)c, (long long)z->i); \
} \
static uint16_t omni_js_json_at(omni_js_json_cur *z) { \
  if (z->i >= z->len) omni_js_json_eoi(); \
  return z->p[z->i]; \
} \
static void omni_js_json_ws(omni_js_json_cur *z) { \
  while (z->i < z->len) { \
    uint16_t c = z->p[z->i]; \
    if (c != 32 && c != 9 && c != 10 && c != 13) break; \
    z->i++; \
  } \
} \
static bool omni_js_json_digit(uint16_t c) { return c >= 48 && c <= 57; } \
static bool omni_js_json_word(omni_js_json_cur *z, const char *w) { \
  int64_t n = (int64_t)strlen(w); \
  if (z->i + n > z->len) return false; \
  for (int64_t k = 0; k < n; k++) { \
    if (z->p[z->i + k] != (uint16_t)(unsigned char)w[k]) return false; \
  } \
  z->i += n; \
  return true; \
} \
OMNI_JS_JSON_4(LT, DT)


/* 第四段：字符串与数。
   字符串进来时游标一定停在开引号上（调用点已经看过了）。缓冲按剩余长度开：转义
   只会让结果变短。生的控制字符（< U+0020）在 JSON 里非法，这一格必须报错 ——
   不然 stringify 转义了、parse 又收生的，来回一趟就不是同一份文本了。
   孤立的代理项照收：宿主 JSON.parse 也照收，s16 存的本来就是码元。 */
#define OMNI_JS_JSON_4(LT, DT) \
static omni_s16 omni_js_json_str(omni_js_json_cur *z) { \
  uint16_t *out = (uint16_t *)omni_alloc((size_t)(z->len - z->i + 1) * sizeof(uint16_t)); \
  int64_t n = 0; \
  z->i++; \
  for (;;) { \
    uint16_t c = omni_js_json_at(z); \
    if (c == 0x22) { omni_s16 r; z->i++; r.p = out; r.len = n; return r; } \
    if (c < 0x20) omni_js_json_bad(z); \
    if (c != 0x5c) { out[n++] = c; z->i++; continue; } \
    z->i++; \
    { \
      uint16_t e = omni_js_json_at(z); \
      if (e == 0x22 || e == 0x5c || e == 0x2f) { out[n++] = e; z->i++; continue; } \
      if (e == 98) { out[n++] = 8; z->i++; continue; } \
      if (e == 102) { out[n++] = 12; z->i++; continue; } \
      if (e == 110) { out[n++] = 10; z->i++; continue; } \
      if (e == 114) { out[n++] = 13; z->i++; continue; } \
      if (e == 116) { out[n++] = 9; z->i++; continue; } \
      if (e != 117) omni_js_json_bad(z); \
      z->i++; \
      { \
        int v = 0; \
        int k; \
        for (k = 0; k < 4; k++) { \
          uint16_t h = omni_js_json_at(z); \
          int d = (h >= 48 && h <= 57) ? h - 48 \
            : (h >= 97 && h <= 102) ? h - 87 \
              : (h >= 65 && h <= 70) ? h - 55 : -1; \
          if (d < 0) omni_js_json_bad(z); \
          v = v * 16 + d; \
          z->i++; \
        } \
        out[n++] = (uint16_t)v; \
      } \
    } \
  } \
} \
static double omni_js_json_num(omni_js_json_cur *z) { \
  int64_t start = z->i; \
  if (omni_js_json_at(z) == 45) z->i++; \
  { \
    uint16_t c = omni_js_json_at(z); \
    if (c == 48) z->i++; \
    else if (c >= 49 && c <= 57) { \
      while (z->i < z->len && omni_js_json_digit(z->p[z->i])) z->i++; \
    } else omni_js_json_bad(z); \
  } \
  if (z->i < z->len && z->p[z->i] == 46) { \
    z->i++; \
    if (!omni_js_json_digit(omni_js_json_at(z))) omni_js_json_bad(z); \
    while (z->i < z->len && omni_js_json_digit(z->p[z->i])) z->i++; \
  } \
  if (z->i < z->len && (z->p[z->i] == 101 || z->p[z->i] == 69)) { \
    z->i++; \
    if (z->i < z->len && (z->p[z->i] == 43 || z->p[z->i] == 45)) z->i++; \
    if (!omni_js_json_digit(omni_js_json_at(z))) omni_js_json_bad(z); \
    while (z->i < z->len && omni_js_json_digit(z->p[z->i])) z->i++; \
  } \
  { \
    int64_t n = z->i - start; \
    char *buf = (char *)omni_alloc(n + 1); \
    int64_t k; \
    for (k = 0; k < n; k++) buf[k] = (char)z->p[start + k]; \
    buf[n] = 0; \
    return strtod(buf, NULL); \
  } \
} \
OMNI_JS_JSON_5(LT, DT)

/* 第五段：一格值与入口。
   实参先按 JS 的口径转字符串（JSON.parse(5) 是 5，不是报错），再从头读一格值，
   末尾除了空白不许还有东西。 */
#define OMNI_JS_JSON_5(LT, DT) \
static omni_dyn omni_js_json_read(omni_js_json_cur *z) { \
  uint16_t c; \
  omni_js_json_ws(z); \
  c = omni_js_json_at(z); \
  if (c == 0x22) return omni_dyn_of_s16(omni_js_json_str(z)); \
  if (c == 0x7b) { \
    omni_dyn o = omni_js_obj_new(); \
    z->i++; \
    omni_js_json_ws(z); \
    if (omni_js_json_at(z) == 0x7d) { z->i++; return o; } \
    for (;;) { \
      omni_s16 k; \
      omni_js_json_ws(z); \
      if (omni_js_json_at(z) != 0x22) omni_js_json_bad(z); \
      k = omni_js_json_str(z); \
      omni_js_json_ws(z); \
      if (omni_js_json_at(z) != 0x3a) omni_js_json_bad(z); \
      z->i++; \
      omni_js_obj_setk(o, omni_s16_to_utf8(k), omni_js_json_read(z)); \
      omni_js_json_ws(z); \
      { \
        uint16_t d = omni_js_json_at(z); \
        if (d == 0x2c) { z->i++; continue; } \
        if (d != 0x7d) omni_js_json_bad(z); \
      } \
      z->i++; \
      return o; \
    } \
  } \
  if (c == 0x5b) { \
    LT l = LT##_new(); \
    z->i++; \
    omni_js_json_ws(z); \
    if (omni_js_json_at(z) == 0x5d) { z->i++; return omni_js_arr_wrap(l); } \
    for (;;) { \
      LT##_push(l, omni_js_json_read(z)); \
      omni_js_json_ws(z); \
      { \
        uint16_t d = omni_js_json_at(z); \
        if (d == 0x2c) { z->i++; continue; } \
        if (d != 0x5d) omni_js_json_bad(z); \
      } \
      z->i++; \
      return omni_js_arr_wrap(l); \
    } \
  } \
  if (omni_js_json_word(z, "true")) return omni_dyn_of_bool(true); \
  if (omni_js_json_word(z, "false")) return omni_dyn_of_bool(false); \
  if (omni_js_json_word(z, "null")) return omni_dyn_null(); \
  if (c == 45 || omni_js_json_digit(c)) return omni_dyn_of_real(omni_js_json_num(z)); \
  omni_js_json_bad(z); \
} \
static omni_dyn omni_js_json_revive(omni_dyn rep, omni_dyn holder, omni_s16 key, omni_dyn val) { \
  if (val.tag == OMNI_DYN_LIST) { \
    LT l = (LT)val.u.ref; \
    for (int64_t i = 0; i < l->len; i++) { \
      omni_s16 ik = omni_js_as_s16(omni_js_str(omni_dyn_of_real((double)i))); \
      l->items[i] = omni_js_json_revive(rep, val, ik, l->items[i]); \
    } \
  } else if (val.tag == OMNI_DYN_DICT) { \
    DT d = (DT)val.u.ref; \
    int64_t n = d->n; \
    for (int64_t i = 0; i < n; i++) { \
      omni_str k; \
      omni_dyn r; \
      if (!d->live[i]) continue; \
      k = d->keys[i]; \
      r = omni_js_json_revive(rep, val, omni_s16_of_utf8(k), d->vals[i]); \
      if (r.tag == OMNI_DYN_UNDEF) omni_js_obj_deletek(val, k); \
      else omni_js_obj_setk(val, k, r); \
    } \
  } \
  { \
    LT args = LT##_new(); \
    LT##_reserve(args, 2); \
    args->items[0] = omni_dyn_of_s16(key); \
    args->items[1] = val; \
    args->len = 2; \
    return omni_js_call_this(rep, holder, omni_js_arr_wrap(args)); \
  } \
} \
static omni_dyn omni_js_json_parse(omni_dyn text, omni_dyn rep) { \
  omni_js_json_cur z; \
  omni_dyn v; \
  omni_s16 s = omni_js_as_s16(omni_js_str(text)); \
  z.p = s.p; \
  z.len = s.len; \
  z.i = 0; \
  v = omni_js_json_read(&z); \
  omni_js_json_ws(&z); \
  if (z.i != z.len) { \
    omni_errorf("unexpected non-whitespace character after JSON at position %lld", (long long)z.i); \
  } \
  if (rep.tag == OMNI_DYN_FN) { \
    omni_dyn root = omni_js_obj_new(); \
    omni_js_obj_setk(root, omni_str_new("", 0), v); \
    return omni_js_json_revive(rep, root, omni_js_s16_lit(""), v); \
  } \
  return v; \
}

#endif /* OMNI_JS_JSON_H */
