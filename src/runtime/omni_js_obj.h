/* JS 的 Map / Set / 普通对象（ADR-0011 的 ABI 里 js_map_* / js_set_* / js_obj_* 那一段）
 *
 * 同样是宏：要造和读 dict<string, dynamic> 与 list<dynamic>，那是生成 TU 里的实例。
 *
 * 三种东西的表示（标签是三个：DICT / MAP / SET —— 底子同是 dict，但成员派发
 * （o.has(k) 到底是 Map 还是普通对象）只有标签能分开，往字典里塞隐藏键会污染迭代）：
 *   - 普通对象 -> dict<string, dynamic>，键是属性名的 UTF-8。属性名进出都要转码
 *     （JS 域里是 str16），这是 ADR-0011 第 8 节的代价，先接受。
 *   - Map -> dict<string, dynamic>，键是**带标签的规范化字符串**，值是一个两元素的
 *     list：[原键, 值]。为什么不直接用属性名那套：量过的源码里有两张 Map 用数字键
 *     （模块 id -> 导入的模块 id），"1" 和 1n 不能撞在一起；而 .keys() 又必须还回
 *     原来的键，所以原键得存着。
 *   - Set -> dict<string, dynamic>，键同上，值就是原元素。
 *
 * 迭代序是插入序：dict 的 keys[]/live[] 本来就是插入序（ADR-0005 的 dict_order 那条
 * 对照测试盯着这件事）。JS 的 Map/Set/Object 也都是插入序，对得上。
 *
 * 宏体里每一行都要有行尾反斜杠，注释一律写在 #define 外面。
 */
#ifndef OMNI_JS_OBJ_H
#define OMNI_JS_OBJ_H

/* 规范化键：标签前缀保证不同类型的键不会撞。对象引用当键会直接报错 —— 量过的源码里
   没有这种用法，与其编一套引用 id，不如撞上了当场说清楚。

   前缀刻意**不**用 omni_str_fmt("s%.*s")：printf 的 %s 在第一个 NUL 处就停了，于是
   "" 与 "\0" 撞成同一个键，而 node 上它们是两个键 —— 一处静默分叉。字符串键里真的会
   出现 U+0000（词法器的转义表里就有一条 '0' -> '\0'）。 */
#define OMNI_JS_OBJ(LT, DT) \
static DT omni_js_dict_of(omni_dyn v) { return (DT)omni_dyn_as_ref(v, OMNI_DYN_DICT); } \
static omni_dyn omni_js_dict_wrap(DT d) { return omni_dyn_of_ref((void *)d, OMNI_DYN_DICT); } \
static DT omni_js_map_of(omni_dyn v) { return (DT)omni_dyn_as_ref(v, OMNI_DYN_MAP); } \
static omni_dyn omni_js_map_wrap(DT d) { return omni_dyn_of_ref((void *)d, OMNI_DYN_MAP); } \
static DT omni_js_set_of(omni_dyn v) { return (DT)omni_dyn_as_ref(v, OMNI_DYN_SET); } \
static omni_dyn omni_js_set_wrap(DT d) { return omni_dyn_of_ref((void *)d, OMNI_DYN_SET); } \
static omni_str omni_js_key_tag_(char t, omni_str u) { \
  char *p = (char *)omni_alloc((size_t)u.len + 1); \
  p[0] = t; \
  if (u.len > 0) memcpy(p + 1, u.p, (size_t)u.len); \
  omni_str r; r.p = p; r.len = u.len + 1; return r; \
} \
static omni_str omni_js_key(omni_dyn k) { \
  switch (k.tag) { \
    case OMNI_DYN_STR16: return omni_js_key_tag_('s', omni_s16_to_utf8(k.u.s16)); \
    /* 核心方言的 string 也可能经 dynamic 走到这里：它必须与 STR16 同键（内容相同就是
       同一个键），**不能**掉进底下那条按地址认的路 —— 那会把两个相等的字符串算成两个键。 */ \
    case OMNI_DYN_STRING: return omni_js_key_tag_('s', k.u.s); \
    case OMNI_DYN_INT: return omni_str_fmt("i%lld", (long long)k.u.i); \
    case OMNI_DYN_UINT: return omni_str_fmt("i%llu", (unsigned long long)omni_dyn_u64(k)); \
    case OMNI_DYN_REAL: \
      return omni_js_key_tag_('n', omni_s16_to_utf8(omni_js_as_s16(omni_js_str(k)))); \
    case OMNI_DYN_BOOL: return omni_str_fmt("b%d", k.u.b ? 1 : 0); \
    case OMNI_DYN_NULL: return omni_str_new("z", 1); \
    case OMNI_DYN_UNDEF: return omni_str_new("u", 1); \
    /* 引用值按**同一性**当键（JS 就是这么规定的）。这个运行时不搬对象、也不回收
       （bump arena），所以地址在一趟里就是同一性。号只在内部当键用 —— 键与值都原样
       存着、迭代不看它，所以 JS 侧发计数器、这里发地址，两边输出仍然逐字节相同。 */ \
    default: return omni_str_fmt("o%p", k.u.ref); \
  } \
} \
static omni_str omni_js_prop(omni_dyn k) { return omni_s16_to_utf8(omni_js_as_s16(k)); } \
static omni_dyn omni_js_obj_new(void) { return omni_js_dict_wrap(DT##_new()); } \
/* JS 里数组也是对象，身上可以挂字段（asy 前端的 do-while 就往那一格更新列表上挂一个 dw）。
   这个值域里 list 只是一段 items/len、没有属性槽，所以额外属性放在一张**按同一性索引的
   旁表**里：键就是 omni_js_key 给引用值发的那个（地址）。list 本身于是不为此多一个字段，
   没挂过属性的 list 一分钱不付。刻意只对 list 开这条路 —— 字符串、Map 上取不到的成员
   照旧当场报，那句话是「成员表缺一格」的固定签名，不能让它变成静悄悄的 undefined。 */ \
static DT omni_js_xprops_tbl_; \
static DT omni_js_xprops_(omni_dyn o, bool make) { \
  omni_str id = omni_js_key(o); \
  if (omni_js_xprops_tbl_ == NULL) { \
    if (!make) return NULL; \
    omni_js_xprops_tbl_ = DT##_new(); \
  } \
  int64_t e = DT##_find(omni_js_xprops_tbl_, id); \
  if (e >= 0) return (DT)omni_js_xprops_tbl_->vals[e].u.ref; \
  if (!make) return NULL; \
  DT d = DT##_new(); \
  DT##_set(omni_js_xprops_tbl_, id, omni_js_dict_wrap(d)); \
  return d; \
} \
/* 键是不是一格**规范的十进制下标**（"0" / "12"；不收 "01" / "+1" / "1e2"）。不是就给 -1。
   数组身上的 `0 in a`、`a["1"]` 的读与写都靠它 —— 与 prelude 那份的判据对着写。 */ \
static int64_t omni_js_dec_index(omni_str key) { \
  if (key.len == 0 || key.len > 18) return -1; \
  if (key.p[0] == '0') return key.len == 1 ? 0 : -1; \
  int64_t n = 0; \
  for (int64_t i = 0; i < key.len; i++) { \
    char c = key.p[i]; \
    if (c < '0' || c > '9') return -1; \
    n = n * 10 + (c - '0'); \
  } \
  return n; \
} \
/* 键是编译期字面量时走这四条：字典里的键本来就是 UTF-8，字面量池已经把它算好了
 * （见 backend-c/emit.js 的 s16PoolLines），omni_js_prop 那次转换和分配就整个省掉。
 * 解释器把 OIR 节点当 dict 读，`e.kind` 这类取字段全落在这里，是原生构建最热的一条。 */ \
static omni_dyn omni_js_obj_getk(omni_dyn o, omni_str key) { \
  DT d; \
  if (o.tag == OMNI_DYN_LIST) { \
    /* 下标形状的字符串键就是下标（`a["1"]`）—— 与写那一边同一条判据 */ \
    int64_t idx = omni_js_dec_index(key); \
    if (idx >= 0) { \
      LT l = (LT)o.u.ref; \
      return idx < l->len ? l->items[idx] : omni_dyn_undef(); \
    } \
    d = omni_js_xprops_(o, false); \
    if (d == NULL) return omni_dyn_undef(); \
  } else { \
    d = omni_js_dict_of(o); \
  } \
  /* contains + get 是两次哈希 —— 取属性是解释器最热的一条，只探一次 */ \
  int64_t e = DT##_find(d, key); \
  if (e < 0) return omni_dyn_undef(); \
  return d->vals[e]; \
} \
static omni_dyn omni_js_obj_setk(omni_dyn o, omni_str key, omni_dyn v) { \
  if (o.tag == OMNI_DYN_LIST && key.len == 6 && memcmp(key.p, "length", 6) == 0) { \
    /* a.length = n 是**改长度**，不是往旁表里挂一个叫 length 的字段（从前是后者，于是
       a.length = 0 静静地什么也没做）。短了截掉、长了补 undefined —— 规范 10.4.2.4。 */ \
    LT l = (LT)o.u.ref; \
    int64_t n = omni_js_arr_i(v); \
    if (n < 0) omni_error("invalid array length"); \
    if (n < l->len) { l->len = n; return o; } \
    LT##_reserve(l, n); \
    while (l->len < n) l->items[l->len++] = omni_dyn_undef(); \
    return o; \
  } \
  /* 下标形状的**字符串**键就是下标：`a["1"] = x` 与 `a[1] = x` 是同一格（规范里数组的
     [[Set]] 先把键 ToString、再看它是不是数组下标）。从前这一支落进旁表，那次写就静静
     地丢了 —— 读那一边一直是对的，所以更藏得住。 */ \
  if (o.tag == OMNI_DYN_LIST) { \
    int64_t idx = omni_js_dec_index(key); \
    if (idx >= 0) { omni_js_arr_set(o, omni_dyn_of_real((double)idx), v); return o; } \
  } \
  DT##_set(o.tag == OMNI_DYN_LIST ? omni_js_xprops_(o, true) : omni_js_dict_of(o), key, v); \
  return o; \
} \
static bool omni_js_obj_hask(omni_dyn o, omni_str key) { \
  if (o.tag == OMNI_DYN_LIST) { \
    /* 元素那几格**也算键**（`0 in a` 是 true）：下标在 0..len-1 里就有，length 也是自有的
       一格。从前这儿只问了旁表，于是 0 in [1,2] 静静地给 false。 */ \
    LT l = (LT)o.u.ref; \
    int64_t idx = omni_js_dec_index(key); \
    if (idx >= 0) return idx < l->len; \
    if (key.len == 6 && memcmp(key.p, "length", 6) == 0) return true; \
    DT d = omni_js_xprops_(o, false); \
    return d == NULL ? false : DT##_contains(d, key); \
  } \
  return DT##_contains(omni_js_dict_of(o), key); \
} \
static bool omni_js_obj_deletek(omni_dyn o, omni_str key) { \
  if (o.tag == OMNI_DYN_LIST) { \
    DT d = omni_js_xprops_(o, false); \
    return d == NULL ? true : DT##_remove(d, key); \
  } \
  return DT##_remove(omni_js_dict_of(o), key); \
} \
static omni_dyn omni_js_obj_get(omni_dyn o, omni_dyn k) { \
  return omni_js_obj_getk(o, omni_js_prop(k)); \
} \
static omni_dyn omni_js_obj_set(omni_dyn o, omni_dyn k, omni_dyn v) { \
  return omni_js_obj_setk(o, omni_js_prop(k), v); \
} \
static bool omni_js_obj_has(omni_dyn o, omni_dyn k) { \
  /* in / hasOwn 的键：规范先 ToPropertyKey，**数要按串形算**（0 in a 里左边就是个数）。
     取属性那条路上的 omni_js_prop 照旧只收串 —— 那句报错是「降级发错了」的固定签名。 */ \
  omni_dyn kk = k.tag == OMNI_DYN_REAL ? omni_js_str(k) : k; \
  return omni_js_obj_hask(o, omni_js_prop(kk)); \
} \
static bool omni_js_obj_delete(omni_dyn o, omni_dyn k) { \
  return omni_js_obj_deletek(o, omni_js_prop(k)); \
} \
/* Object.keys / values / entries 也认**串**（规范里先 ToObject，串成了类数组）：
   键是下标的十进制串、值是一个个码元。与 prelude 那份对着写。 */ \
static omni_dyn omni_js_str_idx_keys(omni_s16 v) { \
  LT out = LT##_new(); \
  LT##_reserve(out, v.len); \
  for (int64_t i = 0; i < v.len; i++) { \
    out->items[out->len++] = omni_js_str(omni_dyn_of_real((double)i)); \
  } \
  return omni_js_arr_wrap(out); \
} \
/* list 的自有键：下标先按数值升序，再是**旁表**里那些非下标形状的字符串键（JS 里数组
   也是对象）。与 prelude 的 $js_arr_own_keys 同一套判据 —— 从前 Object.keys/values/
   entries 的 list 那一支落到 omni_js_dict_of 上、当场报 "list is not an object"
   （量出来的：Object.entries([7]) 该给 [["0",7]]）。 */ \
static omni_dyn omni_js_arr_own_keys(omni_dyn a) { \
  LT l = (LT)a.u.ref; \
  LT out = LT##_new(); \
  DT x = omni_js_xprops_(a, false); \
  for (int64_t i = 0; i < l->len; i++) { \
    LT##_push(out, omni_js_str(omni_dyn_of_real((double)i))); \
  } \
  if (x != NULL) { \
    for (int64_t i = 0; i < x->n; i++) { \
      if (!x->live[i]) continue; \
      if (omni_js_dec_index(x->keys[i]) >= 0) continue; \
      LT##_push(out, omni_dyn_of_s16(omni_s16_of_utf8(x->keys[i]))); \
    } \
  } \
  return omni_js_arr_wrap(out); \
} \
/* 上面那串键各自的值。**不能用 omni_js_idx_get** —— 它在 str_arr 那一段里、比这一段后
   展开；下标直接读元素，别的名字落回旁表（omni_js_obj_getk）。 */ \
static omni_dyn omni_js_arr_own_get(omni_dyn a, omni_dyn key) { \
  LT l = (LT)a.u.ref; \
  omni_str k = omni_js_prop(key); \
  int64_t idx = omni_js_dec_index(k); \
  if (idx >= 0 && idx < l->len) return l->items[idx]; \
  return omni_js_obj_getk(a, k); \
} \
static omni_dyn omni_js_obj_keys(omni_dyn o) { \
  if (o.tag == OMNI_DYN_STR16) return omni_js_str_idx_keys(o.u.s16); \
  if (o.tag == OMNI_DYN_LIST) return omni_js_arr_own_keys(o); \
  DT d = omni_js_dict_of(o); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) { \
    if (d->live[i]) out->items[out->len++] = omni_dyn_of_s16(omni_s16_of_utf8(d->keys[i])); \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_obj_values(omni_dyn o) { \
  if (o.tag == OMNI_DYN_STR16) { \
    omni_s16 v = o.u.s16; \
    LT sout = LT##_new(); \
    LT##_reserve(sout, v.len); \
    for (int64_t i = 0; i < v.len; i++) { \
      sout->items[sout->len++] = omni_dyn_of_s16(omni_s16_slice(v, i, i + 1)); \
    } \
    return omni_js_arr_wrap(sout); \
  } \
  if (o.tag == OMNI_DYN_LIST) { \
    LT ks = omni_js_arr_of(omni_js_arr_own_keys(o)); \
    LT lout = LT##_new(); \
    LT##_reserve(lout, ks->len); \
    for (int64_t i = 0; i < ks->len; i++) { \
      lout->items[lout->len++] = omni_js_arr_own_get(o, ks->items[i]); \
    } \
    return omni_js_arr_wrap(lout); \
  } \
  DT d = omni_js_dict_of(o); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) out->items[out->len++] = d->vals[i]; \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_obj_entries(omni_dyn o) { \
  if (o.tag == OMNI_DYN_STR16) { \
    omni_s16 v = o.u.s16; \
    LT sout = LT##_new(); \
    LT##_reserve(sout, v.len); \
    for (int64_t i = 0; i < v.len; i++) { \
      LT p2 = LT##_new(); \
      LT##_reserve(p2, 2); \
      p2->items[0] = omni_js_str(omni_dyn_of_real((double)i)); \
      p2->items[1] = omni_dyn_of_s16(omni_s16_slice(v, i, i + 1)); \
      p2->len = 2; \
      sout->items[sout->len++] = omni_js_arr_wrap(p2); \
    } \
    return omni_js_arr_wrap(sout); \
  } \
  if (o.tag == OMNI_DYN_LIST) { \
    LT ks = omni_js_arr_of(omni_js_arr_own_keys(o)); \
    LT lout = LT##_new(); \
    LT##_reserve(lout, ks->len); \
    for (int64_t i = 0; i < ks->len; i++) { \
      LT p3 = LT##_new(); \
      LT##_reserve(p3, 2); \
      p3->items[0] = ks->items[i]; \
      p3->items[1] = omni_js_arr_own_get(o, ks->items[i]); \
      p3->len = 2; \
      lout->items[lout->len++] = omni_js_arr_wrap(p3); \
    } \
    return omni_js_arr_wrap(lout); \
  } \
  DT d = omni_js_dict_of(o); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) { \
    if (!d->live[i]) continue; \
    LT pair = LT##_new(); \
    LT##_reserve(pair, 2); \
    pair->items[0] = omni_dyn_of_s16(omni_s16_of_utf8(d->keys[i])); \
    pair->items[1] = d->vals[i]; \
    pair->len = 2; \
    out->items[out->len++] = omni_js_arr_wrap(pair); \
  } \
  return omni_js_arr_wrap(out); \
} \
/* { ...src, k: v } 的 src 那一步：把 src 的自有键逐个抄进 dst，返回 dst。
   undefined / null 当空对象（JS 就是这么规定的），其余非对象是错误。 */ \
static omni_dyn omni_js_obj_assign(omni_dyn dst, omni_dyn src) { \
  if (src.tag == OMNI_DYN_UNDEF || src.tag == OMNI_DYN_NULL) return dst; \
  /* 源是数组或字符串：抄的是它的**自有可枚举键**（下标那几格，数组还有旁表里那些名字）——
     { ...[1,2] } 是 {"0":1,"1":2}。判据与 prelude 的 $js_obj_assign 相同（量出来的：
     从前这一支落到 omni_js_dict_of 上、当场报 "list is not an object"）。 */ \
  if (src.tag == OMNI_DYN_LIST || src.tag == OMNI_DYN_STR16) { \
    LT es = omni_js_arr_of(omni_js_obj_entries(src)); \
    for (int64_t i = 0; i < es->len; i++) { \
      LT p = omni_js_arr_of(es->items[i]); \
      omni_js_obj_set(dst, p->items[0], p->items[1]); \
    } \
    return dst; \
  } \
  DT s = omni_js_dict_of(src); \
  DT d = omni_js_dict_of(dst); \
  for (int64_t i = 0; i < s->n; i++) if (s->live[i]) DT##_set(d, s->keys[i], s->vals[i]); \
  return dst; \
} \
/* `x.push(…)` 的派发器。接收者是 list 就整段追加，否则退回「取属性、当函数调」——
   与成员派发器表外那一支同一条路（ADR-0011 决策 12）。用户自己的方法也可以叫 push
   （asy 前端的 `AsyLower.push()` 就是压一层作用域），而 `x.push()` 与 `x.push(...xs)`
   这两种形状降级时走的是这个定长 op，静态分不出接收者 —— 只能在运行期看标签。
   定义在这里而不是 omni_js_arr.h：那个宏先展开，还看不见 omni_js_obj_getk。 */ \
static omni_dyn omni_js_arr_push_dyn(omni_dyn a, omni_dyn items) { \
  if (a.tag == OMNI_DYN_LIST) return omni_js_arr_push_all(a, items); \
  LT l = omni_js_arr_of(items); \
  return omni_js_call_n_this(omni_js_obj_getk(a, omni_str_new("push", 4)), a, l->len, l->items); \
} \
OMNI_JS_MAP(LT, DT)

/* Map / Set。条目值是 [原键, 值] 的两元素 list —— 多一次分配，换来 .keys() 能还回
   原来的键（数字键的那两张表指着这个）。Set 的条目值直接是原元素。 */
#define OMNI_JS_MAP(LT, DT) \
static omni_dyn omni_js_map_new(void) { return omni_js_map_wrap(DT##_new()); } \
static omni_dyn omni_js_map_size(omni_dyn m) { \
  return omni_dyn_of_real((double)omni_js_map_of(m)->count); \
} \
static bool omni_js_map_has(omni_dyn m, omni_dyn k) { \
  return DT##_contains(omni_js_map_of(m), omni_js_key(k)); \
} \
static omni_dyn omni_js_map_get(omni_dyn m, omni_dyn k) { \
  DT d = omni_js_map_of(m); \
  int64_t e = DT##_find(d, omni_js_key(k)); \
  if (e < 0) return omni_dyn_undef(); \
  return ((LT)d->vals[e].u.ref)->items[1]; \
} \
static omni_dyn omni_js_map_set(omni_dyn m, omni_dyn k, omni_dyn v) { \
  LT pair = LT##_new(); \
  LT##_reserve(pair, 2); \
  pair->items[0] = k; \
  pair->items[1] = v; \
  pair->len = 2; \
  DT##_set(omni_js_map_of(m), omni_js_key(k), omni_js_arr_wrap(pair)); \
  return m; \
} \
static bool omni_js_map_delete(omni_dyn m, omni_dyn k) { \
  return DT##_remove(omni_js_map_of(m), omni_js_key(k)); \
} \
/* clear：逐格摘掉（容器模板里没有 clear）。槽位留着、live 置假，与 delete 同一形状 */ \
static void omni_js_map_clear(omni_dyn m) { \
  DT d = omni_js_map_of(m); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) DT##_remove(d, d->keys[i]); \
} \
static omni_dyn omni_js_map_keys(omni_dyn m) { \
  DT d = omni_js_map_of(m); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) { \
    if (d->live[i]) out->items[out->len++] = ((LT)d->vals[i].u.ref)->items[0]; \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_map_values(omni_dyn m) { \
  DT d = omni_js_map_of(m); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) { \
    if (d->live[i]) out->items[out->len++] = ((LT)d->vals[i].u.ref)->items[1]; \
  } \
  return omni_js_arr_wrap(out); \
} \
/* entries 交出来的每一格都是**新的**两元数组：内部存的那一格不能漏出去，
   不然 `[...m][0][0] = x` 会改到 Map 自己（prelude 那份同一条） */ \
static omni_dyn omni_js_map_entries(omni_dyn m) { \
  DT d = omni_js_map_of(m); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) { \
    if (!d->live[i]) continue; \
    LT src = omni_js_arr_of(d->vals[i]); \
    LT pair = LT##_new(); \
    LT##_reserve(pair, 2); \
    pair->items[0] = src->items[0]; \
    pair->items[1] = src->items[1]; \
    pair->len = 2; \
    out->items[out->len++] = omni_js_arr_wrap(pair); \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_set_new(void) { return omni_js_set_wrap(DT##_new()); } \
static omni_dyn omni_js_set_size(omni_dyn s) { \
  return omni_dyn_of_real((double)omni_js_set_of(s)->count); \
} \
static bool omni_js_set_has(omni_dyn s, omni_dyn v) { \
  return DT##_contains(omni_js_set_of(s), omni_js_key(v)); \
} \
static omni_dyn omni_js_set_add(omni_dyn s, omni_dyn v) { \
  DT##_set(omni_js_set_of(s), omni_js_key(v), v); \
  return s; \
} \
static bool omni_js_set_delete(omni_dyn s, omni_dyn v) { \
  return DT##_remove(omni_js_set_of(s), omni_js_key(v)); \
} \
static void omni_js_set_clear(omni_dyn s) { \
  DT d = omni_js_set_of(s); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) DT##_remove(d, d->keys[i]); \
} \
static omni_dyn omni_js_set_items(omni_dyn s) { \
  DT d = omni_js_set_of(s); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) out->items[out->len++] = d->vals[i]; \
  return omni_js_arr_wrap(out); \
} \
/* Map / Set 的 forEach：回调收 (value, key, map) 与 (value, value, set)（规范 24.1.3.5、
   24.2.3.6 —— Set 那边两格都是元素本身）。键是任意值，所以走 omni_js_call 现拼一格
   三实参的表：固定三格的 omni_js_call3 第二格只收 int64 下标。 */ \
static void omni_js_map_for_each(omni_dyn m, omni_dyn f) { \
  LT es = omni_js_arr_of(omni_js_map_entries(m)); \
  for (int64_t i = 0; i < es->len; i++) { \
    LT p = omni_js_arr_of(es->items[i]); \
    const omni_dyn tmp[3] = { p->len > 1 ? p->items[1] : omni_dyn_undef(), \
                              p->len > 0 ? p->items[0] : omni_dyn_undef(), m }; \
    omni_js_call(f, LT##_from(tmp, 3)); \
  } \
} \
static void omni_js_set_for_each(omni_dyn s, omni_dyn f) { \
  LT xs = omni_js_arr_of(omni_js_set_items(s)); \
  for (int64_t i = 0; i < xs->len; i++) { \
    const omni_dyn tmp[3] = { xs->items[i], xs->items[i], s }; \
    omni_js_call(f, LT##_from(tmp, 3)); \
  } \
} \
/* Set 的 entries()：每格是 [v, v]（规范 24.2.3.5 —— 键与值都是元素本身） */ \
static omni_dyn omni_js_set_entries(omni_dyn s) { \
  LT xs = omni_js_arr_of(omni_js_set_items(s)); \
  LT out = LT##_new(); \
  LT##_reserve(out, xs->len); \
  for (int64_t i = 0; i < xs->len; i++) { \
    LT pair = LT##_new(); \
    LT##_reserve(pair, 2); \
    pair->items[0] = xs->items[i]; \
    pair->items[1] = xs->items[i]; \
    pair->len = 2; \
    out->items[i] = omni_js_arr_wrap(pair); \
  } \
  out->len = xs->len; \
  return omni_js_arr_wrap(out); \
} \
/* new Map(pairs) / new Set(items)。初值收 list，**也收同类容器**（浅拷贝）；
   JS 的可迭代协议整体不在这个值域里，别的类型仍然报错；
   缺参数（undefined）就是空容器，和 new Map() 一样。 */ \
static omni_dyn omni_js_map_of_pairs(omni_dyn init) { \
  omni_dyn m = omni_js_map_new(); \
  if (init.tag == OMNI_DYN_UNDEF) return m; \
  LT l = omni_js_arr_of(init.tag == OMNI_DYN_MAP ? omni_js_map_entries(init) : init); \
  for (int64_t i = 0; i < l->len; i++) { \
    LT p = omni_js_arr_of(l->items[i]); \
    omni_js_map_set(m, p->len > 0 ? p->items[0] : omni_dyn_undef(), \
                    p->len > 1 ? p->items[1] : omni_dyn_undef()); \
  } \
  return m; \
} \
static omni_dyn omni_js_set_of_list(omni_dyn init) { \
  omni_dyn s = omni_js_set_new(); \
  if (init.tag == OMNI_DYN_UNDEF) return s; \
  /* 初值收 list / Set / 字符串（规范 24.2.1.1 说的是"任何可迭代的东西"）。字符串按**码点**
     拆 —— 这一段比 omni_js_iter 先展开（宏段顺序），所以在本段里自己拆一遍。 */ \
  if (init.tag == OMNI_DYN_STR16) { \
    omni_s16 v = omni_js_as_s16(init); \
    for (int64_t i = 0; i < v.len; ) { \
      int64_t n = 1; \
      if (v.p[i] >= 0xD800 && v.p[i] <= 0xDBFF && i + 1 < v.len \
          && v.p[i + 1] >= 0xDC00 && v.p[i + 1] <= 0xDFFF) n = 2; \
      omni_js_set_add(s, omni_dyn_of_s16(omni_s16_slice(v, i, i + n))); \
      i += n; \
    } \
    return s; \
  } \
  LT l = omni_js_arr_of(init.tag == OMNI_DYN_SET ? omni_js_set_items(init) \
    : (init.tag == OMNI_DYN_MAP ? omni_js_map_entries(init) : init)); \
  for (int64_t i = 0; i < l->len; i++) omni_js_set_add(s, l->items[i]); \
  return s; \
} \
/* Set 的集合运算（ES2025）：与 prelude 那份一字一句对着写 —— 次序照规范
   （intersection / isDisjointFrom 走小的那个，别的以 this 的次序为主）。 */ \
static omni_dyn omni_js_set_union(omni_dyn a, omni_dyn b) { \
  omni_dyn out = omni_js_set_of_list(omni_js_set_items(a)); \
  LT ys = omni_js_arr_of(omni_js_set_items(b)); \
  for (int64_t i = 0; i < ys->len; i++) omni_js_set_add(out, ys->items[i]); \
  return out; \
} \
static omni_dyn omni_js_set_intersection(omni_dyn a, omni_dyn b) { \
  bool a_first = omni_js_set_of(a)->count <= omni_js_set_of(b)->count; \
  LT xs = omni_js_arr_of(omni_js_set_items(a_first ? a : b)); \
  omni_dyn other = a_first ? b : a; \
  omni_dyn out = omni_js_set_new(); \
  for (int64_t i = 0; i < xs->len; i++) { \
    if (omni_js_set_has(other, xs->items[i])) omni_js_set_add(out, xs->items[i]); \
  } \
  return out; \
} \
static omni_dyn omni_js_set_difference(omni_dyn a, omni_dyn b) { \
  LT xs = omni_js_arr_of(omni_js_set_items(a)); \
  omni_dyn out = omni_js_set_new(); \
  for (int64_t i = 0; i < xs->len; i++) { \
    if (!omni_js_set_has(b, xs->items[i])) omni_js_set_add(out, xs->items[i]); \
  } \
  return out; \
} \
static omni_dyn omni_js_set_sym_difference(omni_dyn a, omni_dyn b) { \
  omni_dyn out = omni_js_set_difference(a, b); \
  LT ys = omni_js_arr_of(omni_js_set_items(b)); \
  for (int64_t i = 0; i < ys->len; i++) { \
    if (!omni_js_set_has(a, ys->items[i])) omni_js_set_add(out, ys->items[i]); \
  } \
  return out; \
} \
static bool omni_js_set_is_subset(omni_dyn a, omni_dyn b) { \
  if (omni_js_set_of(a)->count > omni_js_set_of(b)->count) return false; \
  LT xs = omni_js_arr_of(omni_js_set_items(a)); \
  for (int64_t i = 0; i < xs->len; i++) if (!omni_js_set_has(b, xs->items[i])) return false; \
  return true; \
} \
static bool omni_js_set_is_superset(omni_dyn a, omni_dyn b) { return omni_js_set_is_subset(b, a); } \
static bool omni_js_set_is_disjoint(omni_dyn a, omni_dyn b) { \
  bool a_first = omni_js_set_of(a)->count <= omni_js_set_of(b)->count; \
  LT xs = omni_js_arr_of(omni_js_set_items(a_first ? a : b)); \
  omni_dyn other = a_first ? b : a; \
  for (int64_t i = 0; i < xs->len; i++) if (omni_js_set_has(other, xs->items[i])) return false; \
  return true; \
} \
/* Array.from(v[, f]) 不在这一段里 —— 它要 omni_js_s16_lit（读类数组的 length），
   而那一格在 omni_js_json.h 里、比这一段**后**展开。所以它定义在 omni_js_str_arr.h。 */ \
/* Map.groupBy（ES2024）：回调**只收两个实参**（值、下标）—— 与 map/filter 那批的
   omni_js_call3 不同，所以这儿自己拼两格实参表，不然 (v, i, arr) 那种回调在两条腿上
   看到的第三格会不一样。每组按原顺序攒成一个数组，键按 SameValueZero 比（就是 map 的键）。 */ \
static omni_dyn omni_js_map_group_by(omni_dyn items, omni_dyn f) { \
  omni_dyn m = omni_js_map_new(); \
  LT l = omni_js_arr_of(items); \
  for (int64_t i = 0; i < l->len; i++) { \
    const omni_dyn tmp[2] = { l->items[i], omni_dyn_of_real((double)i) }; \
    omni_dyn k = omni_js_call(f, LT##_from(tmp, 2)); \
    omni_dyn g = omni_js_map_get(m, k); \
    if (g.tag != OMNI_DYN_LIST) { \
      g = omni_js_arr_wrap(LT##_new()); \
      omni_js_map_set(m, k, g); \
    } \
    LT##_push((LT)omni_dyn_as_ref(g, OMNI_DYN_LIST), l->items[i]); \
  } \
  return m; \
}


#endif /* OMNI_JS_OBJ_H */
