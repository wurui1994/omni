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

/* 序列化时的嵌套上限：祖先表借 depth 当下标（见 omni_js_json_val 里那段），所以这一格
   同时是"环检测能看多深"与"递归有多深"的闸门。超了抛 RangeError，不是把栈撑爆。 */
#define OMNI_JS_JSON_MAXDEPTH 512

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
static jmp_buf omni_js_json_jb; \
static omni_dyn omni_js_json_err(const char *kind, omni_s16 msg) { \
  LT cls = LT##_new(); \
  LT##_push(cls, omni_dyn_of_s16(omni_js_s16_lit(kind))); \
  LT##_push(cls, omni_dyn_of_s16(omni_js_s16_lit("Error"))); \
  omni_dyn o = omni_js_obj_new(); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("$cls")), omni_js_arr_wrap(cls)); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("name")), omni_dyn_of_s16(omni_js_s16_lit(kind))); \
  omni_js_obj_set(o, omni_dyn_of_s16(omni_js_s16_lit("message")), omni_dyn_of_s16(msg)); \
  return o; \
} \
static OMNI_NORETURN void omni_js_json_fail(const char *kind, omni_s16 msg) { \
  omni_js_throw(omni_js_json_err(kind, msg)); \
  longjmp(omni_js_json_jb, 1); \
} \
static OMNI_NORETURN void omni_js_json_failc(const char *kind, const char *msg) { \
  omni_js_json_fail(kind, omni_js_s16_lit(msg)); \
} \
static omni_s16 omni_js_json_val(omni_dyn v, omni_dyn rep, omni_s16 gap, int64_t depth, const void **seen); \
static omni_dyn omni_js_json_apply(omni_dyn rep, omni_s16 key, omni_dyn v) { \
  /* replacer 只有**函数**形态才调（数组形态是白名单，见 omni_js_json_list） */ \
  if (rep.tag != OMNI_DYN_FN) return v; \
  LT args = LT##_new(); \
  LT##_reserve(args, 2); \
  args->items[0] = omni_dyn_of_s16(key); \
  args->items[1] = v; \
  args->len = 2; \
  return omni_js_call(rep, args); \
} \
/* replacer 的**数组**形态（白名单，规范 25.5.2.2 的 PropertyList）：只留名单里的键，
   而且**按名单的次序**输出。数字条目按串形算，重复的只留第一次，别的类型忽略。
   rep 不是数组时交出 undefined（"没给白名单"）。 */ \
static omni_dyn omni_js_json_list(omni_dyn rep) { \
  if (rep.tag != OMNI_DYN_LIST) return omni_dyn_undef(); \
  LT src = (LT)rep.u.ref; \
  LT out = LT##_new(); \
  for (int64_t i = 0; i < src->len; i++) { \
    omni_dyn x = src->items[i]; \
    if (x.tag != OMNI_DYN_STR16 && x.tag != OMNI_DYN_REAL) continue; \
    omni_s16 k = omni_js_as_s16(omni_js_str(x)); \
    bool dup = false; \
    for (int64_t j = 0; j < out->len; j++) { \
      if (omni_s16_eq(out->items[j].u.s16, k)) { dup = true; break; } \
    } \
    if (!dup) LT##_push(out, omni_dyn_of_s16(k)); \
  } \
  return omni_js_arr_wrap(out); \
} \
/* 缩进那一格是**一个串**（规范 25.5.2 第 4-6 步：数是那么多空格、串是它自己），
   所以换行那一格是 "\n" 加 depth 遍 gap。与 prelude 的 $js_json_nl 对着写。 */ \
static omni_s16 omni_js_json_nl(omni_s16 gap, int64_t depth) { \
  if (gap.len <= 0) return omni_js_s16_lit(""); \
  uint16_t *out = (uint16_t *)omni_alloc((size_t)(gap.len * depth + 1) * sizeof(uint16_t)); \
  int64_t n = 0; \
  out[n++] = '\n'; \
  for (int64_t d = 0; d < depth; d++) { \
    for (int64_t i = 0; i < gap.len; i++) out[n++] = gap.p[i]; \
  } \
  omni_s16 r; r.p = out; r.len = n; return r; \
} \
static omni_s16 omni_js_json_val(omni_dyn v, omni_dyn rep, omni_s16 gap, int64_t depth, const void **seen) { \
  if (v.tag == OMNI_DYN_DICT) { \
    omni_dyn tj = omni_js_obj_get(v, omni_dyn_of_s16(omni_js_s16_lit("toJSON"))); \
    if (tj.tag == OMNI_DYN_FN) { \
      LT noargs = LT##_new(); \
      v = omni_js_call_this(tj, v, omni_js_arr_wrap(noargs)); \
    } \
  } \
  /* 环（o.self = o）：规范抛 TypeError。从前这儿一路递归下去，把栈撑爆 —— 那是崩，
     比错答案还糟。祖先表借 depth 当下标：一格容器在 depth 上，它的祖先正好占
     seen[0..depth-1]。所以同一格对象出现在兄弟位置上仍然合法（{a:x, b:x}），
     只有落在自己的祖先里才是环。与 prelude 的 $js_json_val 对着写。 */ \
  if (v.tag == OMNI_DYN_LIST || v.tag == OMNI_DYN_DICT) { \
    if (depth >= OMNI_JS_JSON_MAXDEPTH) omni_js_json_failc("RangeError", "JSON nesting too deep"); \
    for (int64_t k = 0; k < depth; k++) { \
      if (seen[k] == v.u.ref) omni_js_json_failc("TypeError", "circular structure in JSON"); \
    } \
    seen[depth] = v.u.ref; \
  } \
  switch (v.tag) { \
    case OMNI_DYN_UNDEF: case OMNI_DYN_FN: return omni_js_json_absent(); \
    case OMNI_DYN_NULL: return omni_js_s16_lit("null"); \
    case OMNI_DYN_BOOL: return omni_js_s16_lit(v.u.b ? "true" : "false"); \
    case OMNI_DYN_REAL: \
      return isfinite(v.u.r) ? omni_js_as_s16(omni_js_str(v)) : omni_js_s16_lit("null"); \
    case OMNI_DYN_STR16: return omni_js_json_quote_s16(v.u.s16); \
    case OMNI_DYN_INT: case OMNI_DYN_UINT: \
      omni_js_json_failc("TypeError", "do not know how to serialize a bigint"); \
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
        omni_s16 s = omni_js_json_val(x, rep, gap, depth + 1, seen); \
        out = omni_s16_cat(out, s.p ? s : omni_js_s16_lit("null")); \
      } \
      out = omni_s16_cat(out, omni_js_json_nl(gap, depth)); \
      return omni_s16_cat(out, omni_js_s16_lit("]")); \
    } \
    /* 真对象（ADR-0020 P1-c 的第十步）：自有的**可枚举字符串键**，值走 [[Get]]（所以
       访问器会被调）。形状与下面 dict 那一支一样，只是键与值的来路不同。 */ \
    case OMNI_DYN_OBJ: { \
      omni_dyn only = omni_js_json_list(rep); \
      LT ks = only.tag == OMNI_DYN_LIST ? (LT)only.u.ref \
                                        : omni_js_arr_of(omni_js_obj_own_keys_o_(v, 'e')); \
      omni_s16 out = omni_js_s16_lit("{"); \
      omni_s16 sep = omni_js_json_nl(gap, depth + 1); \
      bool first = true; \
      for (int64_t i = 0; i < ks->len; i++) { \
        if (ks->items[i].tag != OMNI_DYN_STR16) continue; \
        omni_s16 key = ks->items[i].u.s16; \
        omni_dyn x = omni_js_json_apply(rep, key, omni_js_getp(v, ks->items[i], omni_dyn_undef())); \
        omni_s16 s = omni_js_json_val(x, rep, gap, depth + 1, seen); \
        if (!s.p) continue; \
        if (!first) out = omni_s16_cat(out, omni_js_s16_lit(",")); \
        first = false; \
        out = omni_s16_cat(out, sep); \
        out = omni_s16_cat(out, omni_js_json_quote_s16(key)); \
        out = omni_s16_cat(out, omni_js_s16_lit(gap.len > 0 ? ": " : ":")); \
        out = omni_s16_cat(out, s); \
      } \
      if (first) return omni_js_s16_lit("{}"); \
      out = omni_s16_cat(out, omni_js_json_nl(gap, depth)); \
      return omni_s16_cat(out, omni_js_s16_lit("}")); \
    } \
    case OMNI_DYN_DICT: { \
      DT d = (DT)v.u.ref; \
      omni_dyn only = omni_js_json_list(rep); \
      omni_s16 out = omni_js_s16_lit("{"); \
      omni_s16 sep = omni_js_json_nl(gap, depth + 1); \
      bool first = true; \
      bool iserr = false; \
      for (int64_t i = 0; i < d->n; i++) { \
        if (d->live[i] && omni_s16_eq(omni_s16_of_utf8(d->keys[i]), omni_js_s16_lit("$cls"))) { \
          iserr = true; \
          break; \
        } \
      } \
      if (only.tag == OMNI_DYN_LIST) { \
        LT ks = (LT)only.u.ref; \
        for (int64_t i = 0; i < ks->len; i++) { \
          omni_s16 key = ks->items[i].u.s16; \
          omni_dyn x = omni_js_json_apply(rep, key, omni_js_obj_get(v, ks->items[i])); \
          omni_s16 s = omni_js_json_val(x, rep, gap, depth + 1, seen); \
          if (!s.p) continue; \
          if (!first) out = omni_s16_cat(out, omni_js_s16_lit(",")); \
          first = false; \
          out = omni_s16_cat(out, sep); \
          out = omni_s16_cat(out, omni_js_json_quote_s16(key)); \
          out = omni_s16_cat(out, omni_js_s16_lit(gap.len > 0 ? ": " : ":")); \
          out = omni_s16_cat(out, s); \
        } \
        if (first) return omni_js_s16_lit("{}"); \
        out = omni_s16_cat(out, omni_js_json_nl(gap, depth)); \
        return omni_s16_cat(out, omni_js_s16_lit("}")); \
      } \
      for (int64_t i = 0; i < d->n; i++) { \
        if (!d->live[i]) continue; \
        omni_s16 key = omni_s16_of_utf8(d->keys[i]); \
        /* 错误对象（决策 15 的 { $cls, name, message } 那种 dict）：这四格在 JS 里都不是
           "自有可枚举"的（name 在原型上，message / cause 是 own 但不可枚举），JSON 里
           不该出现 —— $cls 更是内部标记。与 prelude 的 $js_err_new 把它们定成不可枚举
           是同一个口径（量出来的静默分叉：从前印 {"$cls":["Error"],…}）。
           白名单那一支**不跳**：带数组 replacer 的 stringify 走的是 [[Get]]，
           不可枚举的自有属性照样进得来（量过 node 与 qjs 都是）。 */ \
        if (iserr && (omni_s16_eq(key, omni_js_s16_lit("$cls")) \
              || omni_s16_eq(key, omni_js_s16_lit("name")) \
              || omni_s16_eq(key, omni_js_s16_lit("message")) \
              || omni_s16_eq(key, omni_js_s16_lit("cause")))) continue; \
        omni_dyn x = omni_js_json_apply(rep, key, d->vals[i]); \
        omni_s16 s = omni_js_json_val(x, rep, gap, depth + 1, seen); \
        if (!s.p) continue; \
        if (!first) out = omni_s16_cat(out, omni_js_s16_lit(",")); \
        first = false; \
        out = omni_s16_cat(out, sep); \
        out = omni_s16_cat(out, omni_js_json_quote_s16(key)); \
        out = omni_s16_cat(out, omni_js_s16_lit(gap.len > 0 ? ": " : ":")); \
        out = omni_s16_cat(out, s); \
      } \
      if (first) return omni_js_s16_lit("{}"); \
      out = omni_s16_cat(out, omni_js_json_nl(gap, depth)); \
      return omni_s16_cat(out, omni_js_s16_lit("}")); \
    } \
    case OMNI_DYN_MAP: case OMNI_DYN_SET: return omni_js_s16_lit("{}"); \
    default: \
      omni_js_json_fail("TypeError", omni_s16_cat( \
        omni_js_s16_lit("do not know how to serialize a "), \
        omni_js_s16_lit(omni_dyn_tag_name(v.tag)))); \
  } \
} \
/* stringify / parse 的入口都要收一次 longjmp（错在十几处，剥栈比逐层检查 pending 省事）。
   jmp_buf 是一格静态量，所以入口先把它存一份再装自己那一份 —— replacer / toJSON 是用户
   代码，里面完全可以再调一次 JSON.stringify（嵌套），不存就把外层那个落点冲掉了。 */ \
static omni_dyn omni_js_json_stringify(omni_dyn v, omni_dyn rep, omni_dyn indent) { \
  /* 缩进照规范 25.5.2 第 4-6 步：**数**是那么多个空格（最多 10）、**串**是它自己
     （最多前 10 个码元）、别的没有缩进。从前只认数，JSON.stringify(x, null, "\t")
     静静地印成一行。与 prelude 的 $js_json_stringify 对着写。 */ \
  omni_s16 gap = omni_js_s16_lit(""); \
  if (indent.tag == OMNI_DYN_REAL || indent.tag == OMNI_DYN_INT) { \
    int64_t n = (int64_t)omni_js_arr_i(indent); \
    if (n > 10) n = 10; \
    if (n > 0) { \
      uint16_t *sp = (uint16_t *)omni_alloc((size_t)n * sizeof(uint16_t)); \
      for (int64_t i = 0; i < n; i++) sp[i] = ' '; \
      gap.p = sp; \
      gap.len = n; \
    } \
  } else if (indent.tag == OMNI_DYN_STR16) { \
    omni_s16 s = omni_js_as_s16(indent); \
    gap = s.len > 10 ? omni_s16_slice(s, 0, 10) : s; \
  } \
  const void *seen[OMNI_JS_JSON_MAXDEPTH]; \
  jmp_buf save; \
  memcpy(save, omni_js_json_jb, sizeof(jmp_buf)); \
  if (setjmp(omni_js_json_jb)) { \
    memcpy(omni_js_json_jb, save, sizeof(jmp_buf)); \
    return omni_dyn_undef(); \
  } \
  omni_dyn root = omni_js_json_apply(rep, omni_js_s16_lit(""), v); \
  omni_s16 s = omni_js_json_val(root, rep, gap, 0, seen); \
  memcpy(omni_js_json_jb, save, sizeof(jmp_buf)); \
  return s.p ? omni_dyn_of_s16(s) : omni_dyn_undef(); \
} \
OMNI_JS_JSON_3(LT, DT)

/* 第三段：JSON.parse。与 backend-js/prelude.js 里的 $js_json_* 是同一套算法 ——
   两边都按 UTF-16 码元扫，所以报错里的 "position N" 一定是同一个数；文本也逐字相同。

   只认 RFC 8259 那一份：不收注释、单引号、尾逗号、NaN/Infinity。数一律出 real
   （宿主 JSON.parse 也没有 BigInt 那一支）。重复的键后来的赢、位置留在第一次出现的
   地方 —— dict_set 与 JS 侧 Map.set 都是这个语义。没有 reviver。

   解析失败是**能 catch 的 SyntaxError**（ADR-0020）：错误点有十几处、这一族函数互相递归，
   所以出错点 longjmp 回 omni_js_json_parse 那一层（JS 那侧用宿主自己的 throw 做同一件事，
   见 prelude 的 $HostBad）。报错文本两侧照旧逐字相同。 */
#define OMNI_JS_JSON_3(LT, DT) \
typedef struct { const uint16_t *p; int64_t len; int64_t i; } omni_js_json_cur; \
static OMNI_NORETURN void omni_js_json_eoi(void) { \
  omni_js_json_failc("SyntaxError", "unexpected end of JSON input"); \
} \
static OMNI_NORETURN void omni_js_json_bad(omni_js_json_cur *z) { \
  uint16_t c = z->p[z->i]; \
  omni_str t = (c >= 0x20 && c < 0x7f) \
    ? omni_str_fmt("unexpected token '%c' in JSON at position %lld", (char)c, (long long)z->i) \
    : omni_str_fmt("unexpected token \\u%04x in JSON at position %lld", (unsigned)c, (long long)z->i); \
  omni_js_json_fail("SyntaxError", omni_s16_of_utf8(t)); \
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
  /* longjmp 的落点（理由见第三段开头）。jmp_buf 是静态量，所以先存一份 —— reviver 是
     用户代码，里面完全可以再调一次 JSON.parse。 */ \
  jmp_buf save; \
  memcpy(save, omni_js_json_jb, sizeof(jmp_buf)); \
  if (setjmp(omni_js_json_jb)) { \
    memcpy(omni_js_json_jb, save, sizeof(jmp_buf)); \
    return omni_dyn_undef(); \
  } \
  v = omni_js_json_read(&z); \
  omni_js_json_ws(&z); \
  if (z.i != z.len) { \
    omni_js_json_fail("SyntaxError", omni_s16_of_utf8(omni_str_fmt( \
      "unexpected non-whitespace character after JSON at position %lld", (long long)z.i))); \
  } \
  memcpy(omni_js_json_jb, save, sizeof(jmp_buf)); \
  if (rep.tag == OMNI_DYN_FN) { \
    omni_dyn root = omni_js_obj_new(); \
    omni_js_obj_setk(root, omni_str_new("", 0), v); \
    return omni_js_json_revive(rep, root, omni_js_s16_lit(""), v); \
  } \
  return v; \
}

#endif /* OMNI_JS_JSON_H */
