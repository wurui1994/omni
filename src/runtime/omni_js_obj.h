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
/* 原生选择子里“原型成员”那一段的起点（见 OMNI_JS_OBJ 里 omni_js_pm_* 那几格）。
   摆在宏外头：宏体里不能有 #define。 */
#define OMNI_JS_PM_SEL 1000
/* 内建构造器当值用那一段的起点（见 omni_js_realm_ctor）。 */
#define OMNI_JS_CTOR_SEL 2000

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
/* 真对象那一族（ADR-0020 P1-c 的第十步）：定义在这一段的后半（那儿 obj_get / obj_set 都
   已经摊开了），这儿先声明 —— 同一个翻译单元里静态函数先声明后定义是合法的。 */ \
static omni_dyn omni_js_getp(omni_dyn o, omni_dyn k, omni_dyn recv); \
static omni_dyn omni_js_setp(omni_dyn o, omni_dyn k, omni_dyn v, omni_dyn recv); \
static omni_dyn omni_js_obj_own_keys_o_(omni_dyn o, int sel); \
static bool omni_js_obj_has_o_(omni_dyn o, omni_dyn k, bool own); \
static bool omni_js_obj_del_o_(omni_dyn o, omni_dyn k); \
static omni_dyn omni_js_fn_proto_(omni_dyn f); \
static omni_dyn omni_js_obj_keys(omni_dyn o); \
static omni_dyn omni_js_realm_proto(omni_str name); \
static omni_dyn omni_js_realm_ctor(omni_str name); \
/* 生成器的驱动（ADR-0020 P2）：nat_call_ 里那三格原生要它，而它排在后头 */ \
/* 原始值那一族的可迭代来源（list / 串 / Map / Set 摊成一条 list）：住在 STR_ARR 段，
   同一个翻译单元里先声明后定义合法。 */ \
static omni_dyn omni_js_iter(omni_dyn v); \
static omni_dyn omni_js_src_iter_(omni_dyn v); \
static omni_dyn omni_js_gen_res(omni_dyn v, omni_dyn done); \
/* 异常对象的构造（$cls 链 + message）：住在 STR_ARR 段，而 Promise.any 全拒时要在这儿
   造一格 AggregateError。 */ \
static omni_dyn omni_js_err_new(omni_dyn msg, omni_dyn cls, omni_dyn opts); \
/* Promise 与作业队列（ADR-0020 P2）：核心四格 + 一格静态队列，形状与 prelude 的
   $js_prom_* 逐条对应。C 这边每个回调都得是带载荷的原生，所以 sel 又排了一段（18..28）。 */ \
static omni_dyn omni_js_prom_new_(void); \
static bool omni_js_prom_is_(omni_dyn v); \
static omni_dyn omni_js_prom_react_(omni_dyn p, omni_dyn f, omni_dyn r); \
static void omni_js_prom_settle_(omni_dyn p, int64_t st, omni_dyn val); \
static void omni_js_async_tick_(omni_dyn p, omni_dyn step, omni_dyn v, int64_t mode); \
static LT omni_js_prom_slot_(omni_dyn p, const char *nm, int64_t n); \
static void omni_js_comb_dec_(LT st); \
static omni_dyn omni_js_agg_err_(omni_dyn errs); \
/* ES2025 的迭代器 helper（Iterator.prototype 上那 11 格）：造一格惰性 helper 与几个小工具。
   排在 nat_call_ 之后，所以这儿先声明。 */ \
static omni_dyn omni_js_it_up_(omni_dyn v); \
static void omni_js_it_close_(omni_dyn it); \
static bool omni_js_it_done_(omni_dyn r); \
static omni_dyn omni_js_it_val_(omni_dyn r); \
static int64_t omni_js_it_count_(omni_dyn n, const char *who); \
static omni_dyn omni_js_it_help_(int64_t kind, omni_dyn up, omni_dyn fn, int64_t n); \
static omni_dyn omni_js_gen_step_(omni_dyn g, omni_dyn v, int64_t mode); \
/* 函数值的 prototype 那张按同一性索引的旁表（$FNPROTO 的孪生）：realm_ctor 要往里预先坐一格，
   而它排在 fn_proto_ 前头，所以表在这儿声明。 */ \
static DT omni_js_fnproto_tbl_; \
static omni_dyn omni_js_proto_of_tag_(omni_dyn v); \
/* 原生函数值（realm 上那些成员、以及 f.call / f.apply）：造一格与按 sel 分派 */ \
struct omni_js_nat_s { omni_fnptr fp; int64_t sel; omni_dyn a; }; \
static omni_dyn omni_js_nat_(int64_t sel, omni_dyn a); \
static omni_dyn omni_js_nat_call_(omni_fn me, LT args); \
/* 内建原型上的成员（`Array.prototype.map` 那一族，ADR-0020 P1-c）。那 93 格的实现是 emit 期
   照 JS_MEMBERS 生成的 static 函数（backend-c 的 memberDispatch），住在这一段**之后**，
   所以这儿只留两格函数指针：一格按 (原型名, 成员名) 查号，一格按号调。main 里登记一次
   （protoMembers 发的 omni_js_pm_init_）。没登记的时候读成员照旧当场报。
   sel 从 OMNI_JS_PM_SEL 起就是"第 ix 格原型成员"，载荷是 [名字, 形参个数]。 */ \
/* 内建构造器的名字与形参个数（与 prelude 的 $js_mk_ctors 那 11 行一一对应）。 */ \
static const char *omni_js_ctor_nm_[11] = { "Object", "Function", "Array", "String", "Number", \
  "Boolean", "Symbol", "RegExp", "Map", "Set", "Date" }; \
static const int64_t omni_js_ctor_ln_[11] = { 1, 1, 1, 1, 1, 1, 0, 2, 0, 0, 7 }; \
static omni_dyn omni_js_ctor_tbl_[11]; \
typedef int64_t (*omni_js_pm_find_t)(omni_str pr, omni_str nm, int64_t *argc); \
typedef omni_dyn (*omni_js_pm_call_t)(int64_t ix, LT args, omni_dyn self); \
static omni_js_pm_find_t omni_js_pm_find_ = NULL; \
static omni_js_pm_call_t omni_js_pm_call_ = NULL; \
static void omni_js_pm_set_(omni_js_pm_find_t f, omni_js_pm_call_t c) { \
  omni_js_pm_find_ = f; \
  omni_js_pm_call_ = c; \
} \
/* 原生的名字与形参个数（sel 一格一行）。JS 那条腿上它们是 $nat(name, len, …) 里那两格，
   这儿按 sel 查 —— 一格都不能少，少了 `f.call.name` 会静静地给空串。 */ \
static const char *omni_js_nat_name_(int64_t sel, int64_t *len) { \
  switch (sel) { \
    case 1: *len = 0; return "toString"; \
    case 2: *len = 0; return "toLocaleString"; \
    case 3: *len = 0; return "valueOf"; \
    case 4: *len = 1; return "hasOwnProperty"; \
    case 5: *len = 1; return "isPrototypeOf"; \
    case 6: *len = 1; return "propertyIsEnumerable"; \
    case 8: *len = 1; return "call"; \
    case 9: *len = 2; return "apply"; \
    case 11: *len = 1; return "bind"; \
    default: *len = 0; return ""; \
  } \
} \
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
/* 三档锁：Object.freeze / seal / preventExtensions（ADR-0020）。
   这条腿上没有真对象，所以能被锁的只有"容器"那几格（list / dict / Map / Set / bytes）——
   它们身上没有属性槽表，标记只能挂在旁边，与 xprops 同一招：键就是 omni_js_key 给引用值
   发的那个（地址），这个运行时不搬对象也不回收，所以地址在一趟里就是同一性。
   三档是包含关系：冻住 ⊂ 封住 ⊂ 不可扩展。原始值照规范：冻住、封住都算，不可扩展。
   与 prelude 的 $FROZEN / $SEALED / $NOEXT 逐条对齐。 */ \
static DT omni_js_frozen_tbl_, omni_js_sealed_tbl_, omni_js_noext_tbl_; \
static bool omni_js_lockable_(omni_dyn o) { \
  return o.tag == OMNI_DYN_LIST || o.tag == OMNI_DYN_DICT || o.tag == OMNI_DYN_MAP \
    || o.tag == OMNI_DYN_SET || o.tag == OMNI_DYN_BYTES; \
} \
static bool omni_js_lk_has_(DT t, omni_dyn o) { \
  return t != NULL && DT##_find(t, omni_js_key(o)) >= 0; \
} \
static void omni_js_lk_add_(DT *t, omni_dyn o) { \
  if (*t == NULL) *t = DT##_new(); \
  DT##_set(*t, omni_js_key(o), omni_dyn_of_bool(true)); \
} \
static bool omni_js_frozen_(omni_dyn a) { return omni_js_lk_has_(omni_js_frozen_tbl_, a); } \
static bool omni_js_noext_(omni_dyn a) { return omni_js_lk_has_(omni_js_noext_tbl_, a); } \
/* lk_* 交出"拦下来了吗"，拦下时放一格**能 catch** 的 TypeError（消息与 prelude 逐字相同）。
   调用点必须写成"拦下来就 return"的形状，让那格错走出去。 */ \
static bool omni_js_lk_ext(omni_dyn a) { \
  if (!omni_js_noext_(a)) return false; \
  omni_js_type_err_c("object is not extensible"); \
  return true; \
} \
static bool omni_js_lk_del(omni_dyn a) { \
  if (!omni_js_lk_has_(omni_js_sealed_tbl_, a)) return false; \
  omni_js_type_err_c("could not delete property"); \
  return true; \
} \
static bool omni_js_lk_wr(omni_dyn a, int64_t i) { \
  if (!omni_js_frozen_(a)) return false; \
  omni_str m = omni_str_cat(omni_str_new("'", 1), omni_str_int(i)); \
  m = omni_str_cat(m, omni_str_new("' is read-only", 14)); \
  char *z = (char *)omni_alloc((size_t)m.len + 1); \
  for (int64_t j = 0; j < m.len; j++) z[j] = m.p[j]; \
  z[m.len] = 0; \
  omni_js_type_err_c(z); \
  return true; \
} \
/* 真对象上的三档锁走**它自己的位**（ex 与每格槽的 w/c），不走上面那三张旁表：那是给
   容器用的（容器没有属性位）。规范 7.3.15 / 20.1.2.6：freeze = 不可扩展 + 每格不可写、
   不可配置；seal = 不可扩展 + 每格不可配置。判据反着算 —— 只要还有一格能写／能配置，
   或者还能扩展，就不算冻住／封住。 */ \
static bool omni_js_obj_lock_o_(omni_dyn o, bool no_write) { \
  omni_js_objv *ov = (omni_js_objv *)o.u.ref; \
  DT ps = (DT)ov->ps; \
  ov->ex = false; \
  for (int64_t i = 0; i < ps->n; i++) { \
    if (!ps->live[i]) continue; \
    LT sl = (LT)ps->vals[i].u.ref; \
    sl->items[6] = omni_dyn_of_bool(false); \
    if (no_write && !sl->items[1].u.b) sl->items[4] = omni_dyn_of_bool(false); \
  } \
  return true; \
} \
static bool omni_js_obj_locked_o_(omni_dyn o, bool need_write) { \
  omni_js_objv *ov = (omni_js_objv *)o.u.ref; \
  DT ps = (DT)ov->ps; \
  if (ov->ex) return false; \
  for (int64_t i = 0; i < ps->n; i++) { \
    if (!ps->live[i]) continue; \
    LT sl = (LT)ps->vals[i].u.ref; \
    if (sl->items[6].u.b) return false; \
    if (need_write && !sl->items[1].u.b && sl->items[4].u.b) return false; \
  } \
  return true; \
} \
static omni_dyn omni_js_obj_freeze(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) { omni_js_obj_lock_o_(o, true); return o; } \
  if (omni_js_lockable_(o)) { \
    omni_js_lk_add_(&omni_js_frozen_tbl_, o); \
    omni_js_lk_add_(&omni_js_sealed_tbl_, o); \
    omni_js_lk_add_(&omni_js_noext_tbl_, o); \
  } \
  return o; \
} \
static omni_dyn omni_js_obj_seal(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) { omni_js_obj_lock_o_(o, false); return o; } \
  if (omni_js_lockable_(o)) { \
    omni_js_lk_add_(&omni_js_sealed_tbl_, o); \
    omni_js_lk_add_(&omni_js_noext_tbl_, o); \
  } \
  return o; \
} \
static omni_dyn omni_js_obj_prevent_ext(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) { ((omni_js_objv *)o.u.ref)->ex = false; return o; } \
  if (omni_js_lockable_(o)) omni_js_lk_add_(&omni_js_noext_tbl_, o); \
  return o; \
} \
static bool omni_js_obj_is_frozen(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_obj_locked_o_(o, true); \
  return !omni_js_lockable_(o) || omni_js_frozen_(o); \
} \
static bool omni_js_obj_is_sealed(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_obj_locked_o_(o, false); \
  return !omni_js_lockable_(o) || omni_js_lk_has_(omni_js_sealed_tbl_, o); \
} \
static bool omni_js_obj_is_ext(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) return ((omni_js_objv *)o.u.ref)->ex; \
  return omni_js_lockable_(o) && !omni_js_noext_(o); \
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
/* null / undefined 上取属性 / 写属性是**能 catch** 的 TypeError（规范 7.3.2 的 GetV 与
   7.3.4 的 SetV 都先 ToObject）。消息与 prelude 的 $js_prim_get / $js_obj_set 逐字相同，
   也就是 qjs 的那句话（node 那边是另一句，js262 的尺子是 qjs）。算出来的键那条路
   （`null[0]`）qjs 不把键印进消息，所以 has_key 分开传。 */ \
static void omni_js_nullish_err_(const char *verb, omni_str key, bool has_key, omni_dyn o) { \
  omni_str m = omni_str_new(verb, (int64_t)strlen(verb)); \
  if (has_key) { \
    m = omni_str_cat(m, omni_str_new(" property '", 11)); \
    m = omni_str_cat(m, key); \
    m = omni_str_cat(m, omni_str_new("' of ", 5)); \
  } else { \
    m = omni_str_cat(m, omni_str_new(" property of ", 13)); \
  } \
  m = o.tag == OMNI_DYN_NULL ? omni_str_cat(m, omni_str_new("null", 4)) \
                             : omni_str_cat(m, omni_str_new("undefined", 9)); \
  char *z = (char *)omni_alloc((size_t)m.len + 1); \
  for (int64_t i = 0; i < m.len; i++) z[i] = m.p[i]; \
  z[m.len] = 0; \
  omni_js_type_err_c(z); \
} \
/* 键是编译期字面量时走这四条：字典里的键本来就是 UTF-8，字面量池已经把它算好了
 * （见 backend-c/emit.js 的 s16PoolLines），omni_js_prop 那次转换和分配就整个省掉。
 * 解释器把 OIR 节点当 dict 读，`e.kind` 这类取字段全落在这里，是原生构建最热的一条。 */ \
static omni_dyn omni_js_obj_getk(omni_dyn o, omni_str key) { \
  DT d; \
  /* f.prototype：函数不是真对象，那格原型住在旁表上（JS 那条腿上它是 Function.prototype
     身上的一格访问器 —— 同一件事的两种写法）。`F.prototype.m = …` 就靠这一支。 */ \
  if (o.tag == OMNI_DYN_FN && key.len == 9 && memcmp(key.p, "prototype", 9) == 0) { \
    return omni_js_fn_proto_(o); \
  } \
  /* f.name / f.length：按**模板**查那张按 fp 索引的静态表（见 omni.h 的 omni_js_fn_meta）。
     表里没有的答 "" / 0 —— 与 JS 那条腿上 $js_fn_name 读不到 $nm 时一模一样，不是悄悄的
     错答案。别的名字（call / apply / bind …）照旧落到下面那句响错。 */ \
  if (o.tag == OMNI_DYN_FN \
      && ((key.len == 4 && memcmp(key.p, "name", 4) == 0) \
          || (key.len == 6 && memcmp(key.p, "length", 6) == 0))) { \
    omni_fnptr fp = omni_fn_ck((omni_fn)o.u.ref)->fp; \
    /* 原生的那些（realm 的成员、call / apply）按 sel 查名字：它们共用一个 fp，
       所以那张按 fp 索引的表认不出来 —— 少这一支 `f.call.name` 会静静地给空串。 */ \
    if (fp == (omni_fnptr)omni_js_nat_call_) { \
      struct omni_js_nat_s *nn_ = (struct omni_js_nat_s *)o.u.ref; \
      /* bind 出来的那一格：名字与形参个数是每一格自己的，存在载荷 list 的第 2 / 3 格 */ \
      if (nn_->sel == 10) { \
        LT bp = (LT)nn_->a.u.ref; \
        return key.len == 6 ? bp->items[3] : bp->items[2]; \
      } \
      /* 内建构造器那一格：名字与形参个数按 sel 查那两张静态表 */ \
      if (nn_->sel >= OMNI_JS_CTOR_SEL) { \
        int ci = (int)(nn_->sel - OMNI_JS_CTOR_SEL); \
        if (key.len == 6) return omni_dyn_of_real((double)omni_js_ctor_ln_[ci]); \
        return omni_dyn_of_s16(omni_s16_of_utf8( \
          omni_str_new(omni_js_ctor_nm_[ci], (int64_t)strlen(omni_js_ctor_nm_[ci])))); \
      } \
      /* 原型成员那一格：名字与形参个数也是每一格自己的，存在载荷 list 的第 0 / 1 格 */ \
      if (nn_->sel >= OMNI_JS_PM_SEL) { \
        LT pp = (LT)nn_->a.u.ref; \
        return key.len == 6 ? pp->items[1] : pp->items[0]; \
      } \
      int64_t nl = 0; \
      const char *nn = omni_js_nat_name_(((struct omni_js_nat_s *)o.u.ref)->sel, &nl); \
      if (key.len == 6) return omni_dyn_of_real((double)nl); \
      return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(nn, (int64_t)strlen(nn)))); \
    } \
    const omni_js_fn_meta *fm = omni_js_fnmeta_find((const void *)fp); \
    if (key.len == 4) { \
      omni_str nm = fm == NULL ? omni_str_new("", 0) : omni_str_new(fm->nm, fm->nmlen); \
      return omni_dyn_of_s16(omni_s16_of_utf8(nm)); \
    } \
    return omni_dyn_of_real(fm == NULL ? 0.0 : (double)fm->len); \
  } \
  /* f.call / f.apply：一格捕获了目标函数的原生（sel 8 / 9）。接收者走 this 那格槽，
     与别的调用一个路子（omni_js_call_this）。bind 还没有 —— 它的 name 是
     "bound " + 目标的名字，那要把名字存进载荷里，等下一刀。 */ \
  if (o.tag == OMNI_DYN_FN \
      && ((key.len == 4 && memcmp(key.p, "call", 4) == 0) \
          || (key.len == 5 && memcmp(key.p, "apply", 5) == 0))) { \
    return omni_js_nat_(key.len == 4 ? 8 : 9, o); \
  } \
  /* f.bind：sel 10，载荷是一格 list `[目标, this, 名字, 形参个数, …预置的实参]` ——
     名字与个数是**每一格自己的**（"bound f" / max(0, len - 预置个数)），所以不能像别的
     原生那样按 sel 查一张静态表，得存进载荷里。 */ \
  if (o.tag == OMNI_DYN_FN && key.len == 4 && memcmp(key.p, "bind", 4) == 0) { \
    return omni_js_nat_(11, o); \
  } \
  /* 真对象走槽表 + 原型链（ADR-0020 P1-c）：`o.x` 与 `o["x"]` 是同一条路 */ \
  if (o.tag == OMNI_DYN_OBJ) { \
    return omni_js_getp(o, omni_dyn_of_s16(omni_s16_of_utf8(key)), omni_dyn_undef()); \
  } \
  if (o.tag == OMNI_DYN_NULL || o.tag == OMNI_DYN_UNDEF) { \
    omni_js_nullish_err_("cannot read", key, true, o); \
    return omni_dyn_undef(); \
  } \
  if (o.tag == OMNI_DYN_LIST) { \
    /* 下标形状的字符串键就是下标（`a["1"]`）—— 与写那一边同一条判据 */ \
    int64_t idx = omni_js_dec_index(key); \
    if (idx >= 0) { \
      LT l = (LT)o.u.ref; \
      return idx < l->len ? l->items[idx] : omni_dyn_undef(); \
    } \
    d = omni_js_xprops_(o, false); \
    if (d == NULL) return omni_js_getp(omni_js_proto_of_tag_(o), \
                                       omni_dyn_of_s16(omni_s16_of_utf8(key)), o); \
  } else if (o.tag == OMNI_DYN_DICT) { \
    d = omni_js_dict_of(o); \
  } else { \
    /* 原始值 / Map / Set 身上的**表外**成员：走它那格 realm 原型（`omni_js_proto_of_tag_`）。
       那些原型是带 get 陷阱的代理，陷阱照**成员表**答：表里有 C 孪生的发一个原生
       （`"ab".toUpperCase` 取出来能调）、表里有而 C 那侧还没落地的当场报、
       根本不在表里的名字给 undefined —— 那才是这个值域里的答案（`[].zork`）。 */ \
    return omni_js_getp(omni_js_proto_of_tag_(o), \
                        omni_dyn_of_s16(omni_s16_of_utf8(key)), o); \
  } \
  /* contains + get 是两次哈希 —— 取属性是解释器最热的一条，只探一次 */ \
  int64_t e = DT##_find(d, key); \
  if (e >= 0) return d->vals[e]; \
  /* 取不到的名字接着往那格原型上找（规范如此）：dict 是 Object.prototype、list 是
     Array.prototype —— `({a:1}).hasOwnProperty("a")` 与 `[].map` 各靠这一条。
     成员表落地之后 list 那一支也接得上了：陷阱认不出的名字答 undefined，
     所以 `a.zork` 照旧是 undefined，不会变成一句响错。 */ \
  if (o.tag == OMNI_DYN_DICT || o.tag == OMNI_DYN_LIST) { \
    return omni_js_getp(omni_js_proto_of_tag_(o), \
                        omni_dyn_of_s16(omni_s16_of_utf8(key)), o); \
  } \
  return omni_dyn_undef(); \
} \
static omni_dyn omni_js_obj_setk(omni_dyn o, omni_str key, omni_dyn v) { \
  if (o.tag == OMNI_DYN_OBJ) { \
    omni_js_setp(o, omni_dyn_of_s16(omni_s16_of_utf8(key)), v, omni_dyn_undef()); \
    return o; \
  } \
  if (o.tag == OMNI_DYN_NULL || o.tag == OMNI_DYN_UNDEF) { \
    omni_js_nullish_err_("cannot set", key, true, o); \
    return o; \
  } \
  if (o.tag == OMNI_DYN_LIST && key.len == 6 && memcmp(key.p, "length", 6) == 0) { \
    /* a.length = n 是**改长度**，不是往旁表里挂一个叫 length 的字段（从前是后者，于是
       a.length = 0 静静地什么也没做）。短了截掉、长了补 undefined —— 规范 10.4.2.4。 */ \
    LT l = (LT)o.u.ref; \
    int64_t n = omni_js_arr_i(v); \
    /* 越界是能 catch 的 RangeError（规范 10.4.2.4 的 ArraySetLength）—— 从前是硬错 */ \
    if (n < 0) { omni_js_range_err_c("invalid array length"); return o; } \
    /* 封住 / 冻住 / 不可扩展的那格：改长度要么删格子要么加格子，两样都不许 —— 静静地不改 */ \
    if (omni_js_noext_(o)) return o; \
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
  /* 三档锁（ADR-0020）：不可扩展就加不上新名字，冻住连改都不行 —— 非严格赋值，静静地不写 */ \
  if (omni_js_noext_(o)) { \
    DT ex = o.tag == OMNI_DYN_LIST ? omni_js_xprops_(o, false) : omni_js_dict_of(o); \
    bool had = ex != NULL && DT##_contains(ex, key); \
    if (!had || omni_js_frozen_(o)) return o; \
  } \
  DT##_set(o.tag == OMNI_DYN_LIST ? omni_js_xprops_(o, true) : omni_js_dict_of(o), key, v); \
  return o; \
} \
static bool omni_js_obj_hask(omni_dyn o, omni_str key) { \
  if (o.tag == OMNI_DYN_OBJ) { \
    return omni_js_obj_has_o_(o, omni_dyn_of_s16(omni_s16_of_utf8(key)), false); \
  } \
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
  if (o.tag == OMNI_DYN_OBJ) { \
    return omni_js_obj_del_o_(o, omni_dyn_of_s16(omni_s16_of_utf8(key))); \
  } \
  if (o.tag == OMNI_DYN_LIST) { \
    /* `delete a[i]`（i 在长度里）在 JS 里造一格**洞** —— 长度不变、`i in a` 为假、
       JSON 那一格是 null、forEach / Object.keys 全跳过。list 是一排稠密的 dyn，
       表达不出洞，写 undefined 进去只对得上一半，那是悄悄的错答案。所以当场报。
       与 prelude 的 $js_obj_delete 逐字对着写。 */ \
    int64_t hi = omni_js_dec_index(key); \
    /* 封住 / 冻住的那格根本删不掉：照实交 false，一格洞也不会出现（非严格 delete 的口径），
       所以下面那句"表达不出洞"的报错不该拦在前面 */ \
    if (omni_js_lk_has_(omni_js_sealed_tbl_, o)) return false; \
    if (hi >= 0 && hi < ((LT)o.u.ref)->len) { \
      omni_errorf("delete of an array index would leave a hole; use splice(%lld, 1)", \
                  (long long) hi); \
    } \
    DT d = omni_js_xprops_(o, false); \
    return d == NULL ? true : DT##_remove(d, key); \
  } \
  if (omni_js_lk_has_(omni_js_sealed_tbl_, o)) return false; \
  return DT##_remove(omni_js_dict_of(o), key); \
} \
/* get / set / has / delete 的键是同一个口径：规范先 ToPropertyKey，**数按串形算**
   （`d[1] = 5`、`0 in a`、`delete d[1]` 里那个下标都是个数）。omni_js_prop 本身只收串 ——
   那句 "real is not a string" 是「降级发错了」的固定签名，不该被这一族正常写法撞上。 */ \
static omni_str omni_js_prop_k(omni_dyn k) { \
  /* 符号键落到这儿就说明接收者**不是**真对象（普通对象在这条腿上是一格 dict，而 dict 的键
     是 UTF-8 串，挂不了符号）。照实说是哪条腿缺哪一格 —— 从前它掉进 omni_js_as_s16 的
     那句 "symbol is not a string"，响是响了，可像是我们内部炸了。 */ \
  if (k.tag == OMNI_DYN_SYM) { \
    omni_errorf("backend-c: 符号键只在**真对象**上成立，而这一格是普通对象 / 数组" \
                "（ADR-0020 P1-c：带计算键的对象字面量还降成 dict）；" \
                "这份程序请走 --backend js 或解释器"); \
    return omni_str_new("", 0); \
  } \
  return omni_js_prop(k.tag == OMNI_DYN_REAL ? omni_js_str(k) : k); \
} \
static omni_dyn omni_js_obj_get(omni_dyn o, omni_dyn k) { \
  /* 真对象那一支要拿**原样的键**：符号键按同一性发键，过一遍 omni_js_prop_k 就成了串
     （类对象上那格 $init 用的就是符号键 Symbol.omni.classInit）。 */ \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_getp(o, k, omni_dyn_undef()); \
  /* 别的接收者上的符号键：dict / list 自己挂不了符号，可它那格 realm 原型上可能有
     （数组的 Symbol.iterator 就是）—— 所以往原型上问，而不是当场报。 */ \
  if (k.tag == OMNI_DYN_SYM && o.tag != OMNI_DYN_NULL && o.tag != OMNI_DYN_UNDEF) { \
    return omni_js_getp(omni_js_proto_of_tag_(o), k, o); \
  } \
  return omni_js_obj_getk(o, omni_js_prop_k(k)); \
} \
static omni_dyn omni_js_obj_set(omni_dyn o, omni_dyn k, omni_dyn v) { \
  if (o.tag == OMNI_DYN_OBJ) { omni_js_setp(o, k, v, omni_dyn_undef()); return o; } \
  return omni_js_obj_setk(o, omni_js_prop_k(k), v); \
} \
static bool omni_js_obj_has(omni_dyn o, omni_dyn k) { \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_obj_has_o_(o, k, false); \
  return omni_js_obj_hask(o, omni_js_prop_k(k)); \
} \
static bool omni_js_obj_delete(omni_dyn o, omni_dyn k) { \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_obj_del_o_(o, k); \
  return omni_js_obj_deletek(o, omni_js_prop_k(k)); \
} \
/* ---- 真对象（ADR-0020 P1-c 的第十步）--------------------------------------
   槽是一条**8 格的 list**：[v, a, g, s, w, e, c, key]（值、是不是访问器、getter、setter、
   可写、可枚举、可配置、原来的键）。用 list 而不是新开一种 C 结构：这一段里 list 现成，
   而 arena 不回收，少一种要管的东西。键的口径与 prelude 的 $js_pkey 逐格对齐 ——
   符号按**同一性**（地址）发键，别的一律 ToString，所以 o[1] 与 o["1"] 是同一格。 */ \
static omni_str omni_js_pkey_(omni_dyn k) { \
  if (k.tag == OMNI_DYN_SYM) return omni_str_fmt("y%p", k.u.ref); \
  return omni_js_key_tag_('s', omni_s16_to_utf8(omni_js_as_s16(omni_js_str(k)))); \
} \
static DT omni_js_ps_(omni_dyn o) { return (DT)((omni_js_objv *)o.u.ref)->ps; } \
/* 一格 ASCII 名字当属性键。omni_js_s16_lit 住在 JSON 那一段（比这一段后展开），
   所以这儿自己转一次 —— 只在 defineProperty 与 instanceof 那两条冷路上用。 */ \
static omni_dyn omni_js_name_(const char *s, int64_t n) { \
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(s, n))); \
} \
static LT omni_js_slot_new_(omni_dyn keyd, omni_dyn v, bool w, bool e, bool c) { \
  LT s = LT##_new(); \
  LT##_reserve(s, 8); \
  s->items[0] = v; \
  s->items[1] = omni_dyn_of_bool(false); \
  s->items[2] = omni_dyn_undef(); \
  s->items[3] = omni_dyn_undef(); \
  s->items[4] = omni_dyn_of_bool(w); \
  s->items[5] = omni_dyn_of_bool(e); \
  s->items[6] = omni_dyn_of_bool(c); \
  s->items[7] = keyd; \
  s->len = 8; \
  return s; \
} \
/* proto **缺席**（undefined）时原型是 realm 上那格 Object.prototype，给 null 才是真的没有
   原型 —— 与 prelude 的 $js_obj_new_p 一字不差（`proto === undefined ? $realm().objP : proto`）。
   这一条要紧：降级器给类的原型发的正是 js_obj_new_p(undefined)，链走不到 Object.prototype
   的话 `p instanceof Object` 会静静地给 false（两把尺子都给 true）。
   omni_js_new_bare_ 是**不带默认值**的那一格：realm 自己造 Object.prototype 时用它，
   不然就无限递归了。 */ \
static omni_dyn omni_js_new_bare_(omni_dyn proto) { \
  omni_js_objv *ov = (omni_js_objv *)omni_alloc(sizeof(omni_js_objv)); \
  ov->pr = proto; \
  ov->ps = (void *)DT##_new(); \
  ov->ex = true; \
  ov->px_t = omni_dyn_undef(); \
  ov->px_h = omni_dyn_undef(); \
  return omni_dyn_of_ref((void *)ov, OMNI_DYN_OBJ); \
} \
static omni_dyn omni_js_obj_new_p(omni_dyn proto) { \
  return omni_js_new_bare_(proto.tag == OMNI_DYN_UNDEF \
    ? omni_js_realm_proto(omni_str_new("Object", 6)) : proto); \
} \
/* 带属性位的那一格对象：一格真对象（原型是 null —— realm 上那格 Object.prototype 还在
   P1-c 里）。与普通对象字面量刻意分开，见 js_abi.js 里 js_obj_slots 那条注。 */ \
static omni_dyn omni_js_obj_slots(void) { return omni_js_obj_new_p(omni_dyn_null()); } \
/* 沿原型链找一格槽；找到时把**持有者**写进 *holder（setp 要它分清"自有"与"继承"）。 */ \
static LT omni_js_find_slot_(omni_dyn o, omni_str key, omni_dyn *holder) { \
  omni_dyn cur = o; \
  while (cur.tag == OMNI_DYN_OBJ) { \
    DT ps = omni_js_ps_(cur); \
    int64_t e = DT##_find(ps, key); \
    if (e >= 0) { \
      if (holder != NULL) *holder = cur; \
      return (LT)ps->vals[e].u.ref; \
    } \
    cur = ((omni_js_objv *)cur.u.ref)->pr; \
  } \
  return NULL; \
} \
static void omni_js_def_data_(omni_dyn o, omni_dyn k, omni_dyn v, bool w, bool e, bool c) { \
  DT##_set(omni_js_ps_(o), omni_js_pkey_(k), \
           omni_js_arr_wrap(omni_js_slot_new_(k.tag == OMNI_DYN_SYM ? k : omni_js_str(k), \
                                              v, w, e, c))); \
} \
/* 原型链走到尽头时手里那一格。**可能不是真对象** —— 这条腿上对象字面量是 dict，所以
   Object.create({…}) 与类的原型都会让链的末端是一格 dict。取属性、问 in、for-in 都要
   接着在那一格上按容器找；写不用（写只会在接收者身上新建一格自有槽）。 */ \
static omni_dyn omni_js_proto_tail_(omni_dyn o) { \
  omni_dyn cur = o; \
  while (cur.tag == OMNI_DYN_OBJ) cur = ((omni_js_objv *)cur.u.ref)->pr; \
  return cur; \
} \
static bool omni_js_cont_proto_(omni_dyn v) { \
  return v.tag == OMNI_DYN_DICT || v.tag == OMNI_DYN_LIST || v.tag == OMNI_DYN_STR16; \
} \
/* 代理（ADR-0020 P4）。这条腿上只有**目标是对象**的那一种：可调用的代理要一格闭包记录
   （typeof 得给 "function"、p() 走 apply 陷阱），而闭包记录只有生成的代码造得出来 ——
   那一支当场报，不悄悄给一格不能调的对象。
   px_h 不是 undefined 就说明是代理；陷阱在处理器上按名字取，取不到就落到目标上。 */ \
static bool omni_js_is_px_(omni_dyn o) { \
  return o.tag == OMNI_DYN_OBJ && ((omni_js_objv *)o.u.ref)->px_h.tag != OMNI_DYN_UNDEF; \
} \
static omni_dyn omni_js_px_trap_(omni_dyn o, const char *name, int64_t n) { \
  if (!omni_js_is_px_(o)) return omni_dyn_undef(); \
  omni_dyn h = ((omni_js_objv *)o.u.ref)->px_h; \
  omni_dyn f = omni_js_obj_get(h, omni_js_name_(name, n)); \
  return f.tag == OMNI_DYN_NULL ? omni_dyn_undef() : f; \
} \
static omni_dyn omni_js_px_target_(omni_dyn o) { return ((omni_js_objv *)o.u.ref)->px_t; } \
static omni_dyn omni_js_px_call_(omni_dyn f, omni_dyn h, omni_dyn a0, omni_dyn a1, \
                                 omni_dyn a2, int64_t n) { \
  LT args = LT##_new(); \
  LT##_reserve(args, n); \
  if (n > 0) args->items[0] = a0; \
  if (n > 1) args->items[1] = a1; \
  if (n > 2) args->items[2] = a2; \
  args->len = n; \
  return omni_js_call_this(f, h, omni_js_arr_wrap(args)); \
} \
static omni_dyn omni_js_proxy_new(omni_dyn t, omni_dyn h) { \
  if (t.tag == OMNI_DYN_FN) { \
    omni_errorf("backend-c: new Proxy over a function — 可调用的代理要一格闭包记录，" \
                "只有生成的代码造得出来（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器"); \
    return omni_dyn_undef(); \
  } \
  if ((t.tag != OMNI_DYN_OBJ && t.tag != OMNI_DYN_DICT && t.tag != OMNI_DYN_LIST) \
      || (h.tag != OMNI_DYN_OBJ && h.tag != OMNI_DYN_DICT)) { \
    omni_js_type_err_c("new Proxy takes an object target and handler"); \
    return omni_dyn_undef(); \
  } \
  omni_dyn p = omni_js_obj_new_p(omni_dyn_null()); \
  omni_js_objv *ov = (omni_js_objv *)p.u.ref; \
  ov->px_t = t; \
  ov->px_h = h; \
  return p; \
} \
/* [[Get]]（规范 10.1.8）：沿链找，数据槽给值，访问器**调 getter**，接收者是 recv（缺省是
   起点那一格）。真对象之外照旧落回容器那一套 —— 与 prelude 的 $js_getp 逐支对齐。 */ \
static omni_dyn omni_js_getp(omni_dyn o, omni_dyn k, omni_dyn recv) { \
  /* 链的尾巴可能是一格 dict（`Object.create({…})` 那种）。dict 的键是 UTF-8 串、挂不了符号，
     所以符号键落在那儿就是**没有** —— 不能当场报：那会把一次普通的"链上找不到"变成响错
     （量出来的：`String(Object.create({…}))` 在问 Symbol.toPrimitive 时就撞上了）。 */ \
  if (o.tag != OMNI_DYN_OBJ) { \
    if (k.tag == OMNI_DYN_SYM) return omni_dyn_undef(); \
    return omni_js_obj_get(o, k); \
  } \
  omni_dyn self = recv.tag == OMNI_DYN_UNDEF ? o : recv; \
  if (omni_js_is_px_(o)) { \
    omni_dyn f = omni_js_px_trap_(o, "get", 3); \
    if (f.tag == OMNI_DYN_UNDEF) return omni_js_getp(omni_js_px_target_(o), k, self); \
    return omni_js_px_call_(f, ((omni_js_objv *)o.u.ref)->px_h, omni_js_px_target_(o), k, self, 3); \
  } \
  LT sl = omni_js_find_slot_(o, omni_js_pkey_(k), NULL); \
  if (sl == NULL) { \
    omni_dyn tail = omni_js_proto_tail_(o); \
    /* 链的尾巴可能是一格 dict（`Object.create({…})`）：dict 挂不了符号键，所以符号在那儿
       就是"没有" —— 接着往 obj_get 走会撞上"符号键只在真对象上成立"那句响错，而这只是
       一次普通的"链上找不到"（量出来的：`String(Object.create({…}))` 问 Symbol.toPrimitive
       时就撞上了）。 */ \
    if (k.tag == OMNI_DYN_SYM) return omni_dyn_undef(); \
    return omni_js_cont_proto_(tail) ? omni_js_obj_get(tail, k) : omni_dyn_undef(); \
  } \
  if (!sl->items[1].u.b) return sl->items[0]; \
  if (sl->items[2].tag != OMNI_DYN_FN) return omni_dyn_undef(); \
  return omni_js_call_this(sl->items[2], self, omni_js_arr_wrap(LT##_new())); \
} \
/* [[Set]]（规范 10.1.9）：链上的 setter 优先；只有自有的可写数据槽原地写，别的在**接收者**
   身上新建一格（接收者不可扩展就静静地丢 —— 非严格赋值的口径）。 */ \
static omni_dyn omni_js_setp(omni_dyn o, omni_dyn k, omni_dyn v, omni_dyn recv) { \
  if (o.tag != OMNI_DYN_OBJ) return omni_js_obj_set(o, k, v); \
  omni_dyn self = recv.tag == OMNI_DYN_UNDEF ? o : recv; \
  if (omni_js_is_px_(o)) { \
    omni_dyn f = omni_js_px_trap_(o, "set", 3); \
    if (f.tag == OMNI_DYN_UNDEF) { omni_js_setp(omni_js_px_target_(o), k, v, self); return v; } \
    omni_js_px_call_(f, ((omni_js_objv *)o.u.ref)->px_h, omni_js_px_target_(o), k, v, 3); \
    return v; \
  } \
  omni_str key = omni_js_pkey_(k); \
  LT sl = omni_js_find_slot_(o, key, NULL); \
  if (sl != NULL && sl->items[1].u.b) { \
    if (sl->items[3].tag != OMNI_DYN_FN) return v; \
    LT args = LT##_new(); \
    LT##_push(args, v); \
    omni_js_call_this(sl->items[3], self, omni_js_arr_wrap(args)); \
    return v; \
  } \
  if (self.tag != OMNI_DYN_OBJ) { omni_js_obj_set(self, k, v); return v; } \
  DT ps = omni_js_ps_(self); \
  int64_t e = DT##_find(ps, key); \
  if (e >= 0) { \
    LT own = (LT)ps->vals[e].u.ref; \
    if (!own->items[1].u.b) { \
      if (own->items[4].u.b) own->items[0] = v; \
      return v; \
    } \
  } \
  if (!((omni_js_objv *)self.u.ref)->ex) return v; \
  omni_js_def_data_(self, k, v, true, true, true); \
  return v; \
} \
static bool omni_js_obj_has_o_(omni_dyn o, omni_dyn k, bool own) { \
  if (o.tag != OMNI_DYN_OBJ) return false;   /* dict 尾巴：符号键在那儿也是"没有" */ \
  if (omni_js_is_px_(o)) { \
    omni_dyn f = omni_js_px_trap_(o, "has", 3); \
    if (f.tag == OMNI_DYN_UNDEF) { \
      omni_dyn t = omni_js_px_target_(o); \
      return t.tag == OMNI_DYN_OBJ ? omni_js_obj_has_o_(t, k, own) : omni_js_obj_has(t, k); \
    } \
    return omni_js_truthy(omni_js_px_call_(f, ((omni_js_objv *)o.u.ref)->px_h, \
                                          omni_js_px_target_(o), k, omni_dyn_undef(), 2)); \
  } \
  omni_str key = omni_js_pkey_(k); \
  if (own) return DT##_find(omni_js_ps_(o), key) >= 0; \
  if (omni_js_find_slot_(o, key, NULL) != NULL) return true; \
  omni_dyn tail = omni_js_proto_tail_(o); \
  return omni_js_cont_proto_(tail) && omni_js_obj_has(tail, k); \
} \
/* [[Delete]]：不可配置的槽删不掉（交 false），没有那一格也算成功（规范如此）。 */ \
static bool omni_js_obj_del_o_(omni_dyn o, omni_dyn k) { \
  if (o.tag != OMNI_DYN_OBJ) return true; \
  if (omni_js_is_px_(o)) { \
    omni_dyn f = omni_js_px_trap_(o, "deleteProperty", 14); \
    if (f.tag == OMNI_DYN_UNDEF) { \
      omni_dyn t = omni_js_px_target_(o); \
      return t.tag == OMNI_DYN_OBJ ? omni_js_obj_del_o_(t, k) : omni_js_obj_delete(t, k); \
    } \
    return omni_js_truthy(omni_js_px_call_(f, ((omni_js_objv *)o.u.ref)->px_h, \
                                          omni_js_px_target_(o), k, omni_dyn_undef(), 2)); \
  } \
  DT ps = omni_js_ps_(o); \
  omni_str key = omni_js_pkey_(k); \
  int64_t e = DT##_find(ps, key); \
  if (e < 0) return true; \
  if (!((LT)ps->vals[e].u.ref)->items[6].u.b) return false; \
  return DT##_remove(ps, key); \
} \
/* 自有键，按**插入序**（规范说整数下标先升序 —— 真对象上没有下标槽的常见形状，
   而 prelude 那份也是按 ps 的插入序走的，两边对齐）。sel：'s' 字符串键、'e' 可枚举的
   字符串键、'y' 符号键。 */ \
static omni_dyn omni_js_obj_own_keys_o_(omni_dyn o, int sel) { \
  LT out = LT##_new(); \
  if (o.tag != OMNI_DYN_OBJ) return omni_js_arr_wrap(out); \
  if (omni_js_is_px_(o)) { \
    omni_dyn t = omni_js_px_target_(o); \
    omni_dyn f = omni_js_px_trap_(o, "ownKeys", 7); \
    if (f.tag == OMNI_DYN_UNDEF) { \
      return t.tag == OMNI_DYN_OBJ ? omni_js_obj_own_keys_o_(t, sel) : omni_js_obj_keys(t); \
    } \
    /* 陷阱交回来的是一串键；'y' 只要符号键、别的只要字符串键。'e'（Object.keys 那一档）
       照规范还要问一遍目标上那一格可不可枚举 —— 这条腿上目标要么是真对象（问得着）、
       要么是一格 dict（键都可枚举），所以两种都按"在目标上有没有"算。 */ \
    LT ks = omni_js_arr_of(omni_js_px_call_(f, ((omni_js_objv *)o.u.ref)->px_h, t, \
                                           omni_dyn_undef(), omni_dyn_undef(), 1)); \
    for (int64_t i = 0; i < ks->len; i++) { \
      bool is_sym = ks->items[i].tag == OMNI_DYN_SYM; \
      if (sel == 'y') { if (!is_sym) continue; } \
      else if (is_sym) continue; \
      if (sel == 'e') { \
        bool there = t.tag == OMNI_DYN_OBJ ? omni_js_obj_has_o_(t, ks->items[i], true) \
                                           : omni_js_obj_has(t, ks->items[i]); \
        if (!there) continue; \
      } \
      LT##_push(out, ks->items[i]); \
    } \
    return omni_js_arr_wrap(out); \
  } \
  DT ps = omni_js_ps_(o); \
  for (int64_t i = 0; i < ps->n; i++) { \
    if (!ps->live[i]) continue; \
    LT sl = (LT)ps->vals[i].u.ref; \
    bool is_sym = sl->items[7].tag == OMNI_DYN_SYM; \
    if (sel == 'y') { if (!is_sym) continue; } \
    else if (is_sym) continue; \
    if (sel == 'e' && !sl->items[5].u.b) continue; \
    LT##_push(out, sl->items[7]); \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_obj_proto_get(omni_dyn o) { \
  if (o.tag == OMNI_DYN_OBJ) return ((omni_js_objv *)o.u.ref)->pr; \
  /* 别的标签的原型是 realm 上那几格（Array.prototype…），realm 还在 P1-c 里 ——
     照实说，不给 null：null 会把"确实有原型"悄悄答成没有。 */ \
  omni_errorf("backend-c: Object.getPrototypeOf of a %s — 内建原型（realm）现在只在 node " \
              "宿主上成立（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器", \
              omni_dyn_tag_name(o.tag)); \
  return omni_dyn_null(); \
} \
static omni_dyn omni_js_obj_proto_set(omni_dyn o, omni_dyn p) { \
  if (o.tag == OMNI_DYN_OBJ) { \
    ((omni_js_objv *)o.u.ref)->pr = p.tag == OMNI_DYN_UNDEF ? omni_dyn_null() : p; \
    return o; \
  } \
  /* dict 带不了原型（这条腿上"普通对象"就是一格 dict，没有 pr 那一格）。**刻意当场报** ——
     静静地不设就等于把继承丢了：`class Q extends P` 的类对象正是这么串起静态成员的，
     不报的话 Q 上查父类的 static 方法会静悄悄地变成 undefined。 */ \
  omni_errorf("backend-c: setPrototypeOf on a %s — 这条腿上只有真对象带得下原型" \
              "（ADR-0020 P1-c：普通对象是一格 dict）；这份程序请走 --backend js 或解释器", \
              omni_dyn_tag_name(o.tag)); \
  return o; \
} \
/* x instanceof C（规范 13.10.2）：沿 x 的原型链找 C.prototype。这条腿上链的末端可能是
   一格 dict（类的原型是真对象，Object.create({…}) 那种的末端是 dict），所以两种都要认。
   原始值一律为假（规范如此：1 instanceof Number 是 false）；数组 / Map 那些的原型住在
   realm 上，而 realm 还在 P1-c 里 —— 那条路上右边取不出 prototype，到不了这儿。 */ \
static bool omni_js_instanceof_p(omni_dyn v, omni_dyn proto) { \
  /* 原始值一律为假（规范如此：1 instanceof Number 是 false）；数组 / Map / 正则那些"不是
     真对象但有原型"的值从 realm 上那格起步 —— 见 omni_js_proto_of_tag_。 */ \
  if (v.tag == OMNI_DYN_REAL || v.tag == OMNI_DYN_INT || v.tag == OMNI_DYN_UINT \
      || v.tag == OMNI_DYN_BOOL || v.tag == OMNI_DYN_STR16 || v.tag == OMNI_DYN_STRING \
      || v.tag == OMNI_DYN_SYM || v.tag == OMNI_DYN_NULL || v.tag == OMNI_DYN_UNDEF) { \
    return false; \
  } \
  /* 每一步都过 omni_js_proto_of_tag_：链上可能夹着一格 dict（Object.create({…}) 那种），
     那一格的"原型"是 realm 上的 Object.prototype，所以尾巴也接得上。
     步数封顶纯粹是防成环（原型链成环在 JS 里本来就该被 setPrototypeOf 拦，这条腿上还没拦）。 */ \
  omni_dyn cur = omni_js_proto_of_tag_(v); \
  for (int64_t guard = 0; guard < 1000; guard++) { \
    if (cur.tag == OMNI_DYN_NULL || cur.tag == OMNI_DYN_UNDEF) return false; \
    if (cur.tag == proto.tag && cur.u.ref == proto.u.ref) return true; \
    cur = omni_js_proto_of_tag_(cur); \
  } \
  return false; \
} \
static bool omni_js_instanceof(omni_dyn v, omni_dyn ctor) { \
  omni_dyn proto = omni_js_obj_get(ctor, omni_js_name_("prototype", 9)); \
  if (proto.tag != OMNI_DYN_OBJ && !omni_js_cont_proto_(proto)) { \
    omni_js_type_err_c("right-hand side of 'instanceof' is not callable"); \
    return false; \
  } \
  return omni_js_instanceof_p(v, proto); \
} \
/* Object.create(proto[, descs]) 与 Object.defineProperties：定义在 obj_def 之后（那儿才有
   全套属性位），这儿先声明。 */ \
static omni_dyn omni_js_obj_defs(omni_dyn o, omni_dyn descs); \
static omni_dyn omni_js_obj_create(omni_dyn proto, omni_dyn descs) { \
  return omni_js_obj_defs(omni_js_obj_new_p(proto), descs); \
} \
/* Reflect.set / setPrototypeOf / preventExtensions：与赋值那条路的差别只在**答案**上 ——
   交一个布尔，写不进去（不可写、只有 getter、接收者不可扩展）时是 false。
   与 prelude 的 $js_reflect_* 逐条对齐。 */ \
static bool omni_js_reflect_set(omni_dyn o, omni_dyn k, omni_dyn v, omni_dyn recv) { \
  if (o.tag != OMNI_DYN_OBJ) { omni_js_obj_set(o, k, v); return true; } \
  omni_dyn self = recv.tag == OMNI_DYN_UNDEF ? o : recv; \
  omni_str key = omni_js_pkey_(k); \
  LT sl = omni_js_find_slot_(o, key, NULL); \
  if (sl != NULL && sl->items[1].u.b) { \
    if (sl->items[3].tag != OMNI_DYN_FN) return false; \
    omni_js_setp(o, k, v, recv); \
    return true; \
  } \
  if (sl != NULL && !sl->items[4].u.b) return false; \
  if (self.tag == OMNI_DYN_OBJ) { \
    DT ps = omni_js_ps_(self); \
    if (DT##_find(ps, key) < 0 && !((omni_js_objv *)self.u.ref)->ex) return false; \
  } \
  omni_js_setp(o, k, v, recv); \
  return true; \
} \
static bool omni_js_reflect_proto_set(omni_dyn o, omni_dyn p) { \
  omni_js_obj_proto_set(o, p); \
  return true; \
} \
static bool omni_js_reflect_prevent_ext(omni_dyn o) { \
  omni_js_obj_prevent_ext(o); \
  return true; \
} \
/* new.target 那一格槽（ADR-0020）：与 this 那一格同一招 —— 调之前放进去，被调的入口取一次
   就清。类的构造走 $init 那格闭包，不经过 js_fn_construct，所以放槽这件事在降级器里做。 */ \
static omni_dyn omni_js_nt_slot_ = { OMNI_DYN_UNDEF, { 0 } }; \
static omni_dyn omni_js_nt_take(void) { \
  omni_dyn v = omni_js_nt_slot_; \
  omni_js_nt_slot_ = omni_dyn_undef(); \
  return v; \
} \
static omni_dyn omni_js_nt_put(omni_dyn v) { \
  omni_js_nt_slot_ = v; \
  return v; \
} \
/* Object.defineProperty（规范 10.1.6）。真对象上是全套：数据槽或访问器槽，三个位缺省
   都是 false（规范如此 —— `{ value: 1 }` 造的是不可枚举、不可写、不可配置的那一格）。
   数组上**没有描述符这一层**（一排稠密的 dyn + 一张旁表），所以只收"能原样表达出来"的
   那一种：下标在长度里、数据描述符、三个位都真 —— 那正好就是 a[i] = v。别的当场报：
   写进去只能对上一半，那是悄悄的错答案。与 prelude 的 $js_obj_def / $js_arr_def 对着写。 */ \
static omni_dyn omni_js_obj_def(omni_dyn o, omni_dyn k, omni_dyn desc) { \
  bool has_get = omni_js_obj_has(desc, omni_js_name_("get", 3)); \
  bool has_set = omni_js_obj_has(desc, omni_js_name_("set", 3)); \
  bool has_val = omni_js_obj_has(desc, omni_js_name_("value", 5)); \
  bool w = omni_js_truthy(omni_js_obj_get(desc, omni_js_name_("writable", 8))); \
  bool e = omni_js_truthy(omni_js_obj_get(desc, omni_js_name_("enumerable", 10))); \
  bool c = omni_js_truthy(omni_js_obj_get(desc, omni_js_name_("configurable", 12))); \
  if (o.tag == OMNI_DYN_LIST) { \
    int64_t idx = omni_js_dec_index(omni_js_prop_k(k)); \
    if (has_get || has_set || !has_val || !w || !e || !c \
        || idx < 0 || idx >= ((LT)o.u.ref)->len) { \
      omni_errorf("backend-c: defineProperty on an array only takes a plain writable/" \
                  "enumerable/configurable data descriptor for an index inside the length " \
                  "—— list 上没有描述符这一层（ADR-0020）；这份程序请走 --backend js 或解释器"); \
      return o; \
    } \
    omni_js_arr_set(o, omni_dyn_of_real((double)idx), \
                    omni_js_obj_get(desc, omni_js_name_("value", 5))); \
    return o; \
  } \
  if (o.tag != OMNI_DYN_OBJ) { \
    omni_errorf("backend-c: defineProperty on a %s — 这条腿上只有真对象与数组带得下属性" \
                "（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器", \
                omni_dyn_tag_name(o.tag)); \
    return o; \
  } \
  omni_str key = omni_js_pkey_(k); \
  DT ps = omni_js_ps_(o); \
  int64_t at = DT##_find(ps, key); \
  if (at < 0 && !((omni_js_objv *)o.u.ref)->ex) { \
    omni_js_type_err_c("object is not extensible"); \
    return o; \
  } \
  LT sl = at >= 0 ? (LT)ps->vals[at].u.ref \
                  : omni_js_slot_new_(k.tag == OMNI_DYN_SYM ? k : omni_js_str(k), \
                                      omni_dyn_undef(), false, false, false); \
  if (has_get || has_set) { \
    sl->items[1] = omni_dyn_of_bool(true); \
    sl->items[0] = omni_dyn_undef(); \
    if (has_get) sl->items[2] = omni_js_obj_get(desc, omni_js_name_("get", 3)); \
    if (has_set) sl->items[3] = omni_js_obj_get(desc, omni_js_name_("set", 3)); \
  } else { \
    sl->items[1] = omni_dyn_of_bool(false); \
    if (has_val) sl->items[0] = omni_js_obj_get(desc, omni_js_name_("value", 5)); \
    sl->items[4] = omni_dyn_of_bool(w); \
  } \
  sl->items[5] = omni_dyn_of_bool(e); \
  sl->items[6] = omni_dyn_of_bool(c); \
  if (at < 0) DT##_set(ps, key, omni_js_arr_wrap(sl)); \
  return o; \
} \
/* Object.defineProperties(o, descs)：descs 上只算**自有可枚举**的键（符号键也算）。
   与 prelude 的 $js_obj_defs 逐条对齐。 */ \
static omni_dyn omni_js_obj_defs(omni_dyn o, omni_dyn descs) { \
  if (descs.tag == OMNI_DYN_UNDEF || descs.tag == OMNI_DYN_NULL) return o; \
  LT ks = omni_js_arr_of(descs.tag == OMNI_DYN_OBJ ? omni_js_obj_own_keys_o_(descs, 'e') \
                                                   : omni_js_obj_keys(descs)); \
  for (int64_t i = 0; i < ks->len; i++) { \
    omni_js_obj_def(o, ks->items[i], omni_js_obj_get(descs, ks->items[i])); \
    if (omni_js_pending()) return o; \
  } \
  if (descs.tag == OMNI_DYN_OBJ) { \
    LT ys = omni_js_arr_of(omni_js_obj_own_keys_o_(descs, 'y')); \
    for (int64_t i = 0; i < ys->len; i++) { \
      omni_js_obj_def(o, ys->items[i], omni_js_obj_get(descs, ys->items[i])); \
      if (omni_js_pending()) return o; \
    } \
  } \
  return o; \
} \
/* Reflect.defineProperty：与 Object.defineProperty 同一格，只是把"成没成"变成一个布尔。 */ \
static bool omni_js_reflect_def(omni_dyn o, omni_dyn k, omni_dyn d) { \
  omni_js_obj_def(o, k, d); \
  if (omni_js_pending()) { omni_js_take_pending(); return false; } \
  return true; \
} \
/* 迭代协议那两格（规范 7.4.2 / 7.4.4）：GetIterator = 取 Symbol.iterator 再调，
   IteratorNext = 取 next 再调、结果必须是对象。两处都是**能 catch** 的 TypeError。
   与 prelude 的 $js_iter_proto / $js_iter_next 逐条对齐。 */ \
static omni_dyn omni_js_iter_proto(omni_dyn v) { \
  omni_dyn key = omni_js_sym_wk(omni_str_new("iterator", 8)); \
  omni_dyn f = v.tag == OMNI_DYN_OBJ ? omni_js_getp(v, key, omni_dyn_undef()) \
                                     : omni_js_obj_get(v, key); \
  if (f.tag == OMNI_DYN_UNDEF || f.tag == OMNI_DYN_NULL) { \
    omni_js_type_err_c("value is not iterable"); \
    return omni_dyn_undef(); \
  } \
  return omni_js_call_this(f, v, omni_js_arr_wrap(LT##_new())); \
} \
static omni_dyn omni_js_iter_next(omni_dyn it) { \
  omni_dyn f = omni_js_obj_get(it, omni_js_name_("next", 4)); \
  omni_dyn r = omni_js_call_this(f, it, omni_js_arr_wrap(LT##_new())); \
  if (omni_js_pending()) return omni_dyn_undef(); \
  if (!omni_js_is_object(r)) { \
    omni_js_type_err_c("iterator result is not an object"); \
    return omni_dyn_undef(); \
  } \
  return r; \
} \
/* 走一遍迭代协议、摊成一条 list。真对象唯一的"可迭代"来路就是这条（Symbol.iterator +
   next），Array.from / new Set(x) / new Map(x) / omni_js_iter 那几处都用它。
   协议里报的错是能 catch 的：接住就把手里那截交回去，调用点的 pending 检查会接着退。 */ \
static omni_dyn omni_js_iter_o_(omni_dyn v) { \
  LT out = LT##_new(); \
  omni_dyn it = omni_js_iter_proto(v); \
  if (omni_js_pending()) return omni_js_arr_wrap(out); \
  for (;;) { \
    omni_dyn r = omni_js_iter_next(it); \
    if (omni_js_pending()) return omni_js_arr_wrap(out); \
    if (omni_js_truthy(omni_js_obj_get(r, omni_js_name_("done", 4)))) break; \
    LT##_push(out, omni_js_obj_get(r, omni_js_name_("value", 5))); \
  } \
  return omni_js_arr_wrap(out); \
} \
/* ---- realm（ADR-0020 P1-c 的第十三步）--------------------------------------
   realm 是两件事，这一步落的是**同一性**那一半外加 Object.prototype 那一格：

   1. `x instanceof Array` 只问"Array.prototype 在不在 x 的链上"，压根不读原型上的成员 ——
      所以每个内建标签一格**规范的原型对象**就够（omni_js_proto_of_tag_ 把标签映到它）。
   2. `Object.prototype` 的成员表**短而封闭**（规范 20.1.3），写得全，所以这一格是真的可用。
      别的原型（Array / String…）的成员表还没搬过来，所以它们是一格**带 get 陷阱的代理**：
      读成员当场报，不给 undefined —— 少一个名字给 undefined 就是悄悄的错答案。

   原生函数值：闭包记录就是 `{ omni_fnptr fp; …捕获的 }`（见 omni_js_wrap_s），所以这儿一格
   `{ fp, sel, a }` 的记录 + 一个按 sel 分派的入口就够了。接收者走 this 那格槽（读一次就清）。 */ \
static omni_dyn omni_js_nat_call_(omni_fn me, LT args) { \
  struct omni_js_nat_s *n = (struct omni_js_nat_s *)me; \
  omni_dyn self = omni_js_this_take(); \
  omni_dyn a0 = args != NULL && args->len > 0 ? args->items[0] : omni_dyn_undef(); \
  switch (n->sel) { \
    case 1: case 2: return omni_js_obj_to_string(self); /* toString / toLocaleString */ \
    case 3: return self;                                /* valueOf */ \
    case 4: {                                           /* hasOwnProperty */ \
      bool r = self.tag == OMNI_DYN_OBJ ? omni_js_obj_has_o_(self, a0, true) \
             : (self.tag == OMNI_DYN_DICT || self.tag == OMNI_DYN_LIST) \
               ? omni_js_obj_has(self, a0) : false; \
      return omni_dyn_of_bool(r); \
    } \
    case 5: {                                           /* isPrototypeOf */ \
      omni_dyn cur = a0.tag == OMNI_DYN_OBJ ? ((omni_js_objv *)a0.u.ref)->pr : omni_dyn_null(); \
      while (cur.tag == OMNI_DYN_OBJ) { \
        if (cur.u.ref == self.u.ref && self.tag == OMNI_DYN_OBJ) return omni_dyn_of_bool(true); \
        cur = ((omni_js_objv *)cur.u.ref)->pr; \
      } \
      return omni_dyn_of_bool(false); \
    } \
    case 6: {                                           /* propertyIsEnumerable */ \
      if (self.tag != OMNI_DYN_OBJ) { \
        return omni_dyn_of_bool(self.tag == OMNI_DYN_DICT && omni_js_obj_has(self, a0)); \
      } \
      DT ps = omni_js_ps_(self); \
      int64_t e = DT##_find(ps, omni_js_pkey_(a0)); \
      return omni_dyn_of_bool(e >= 0 && ((LT)ps->vals[e].u.ref)->items[5].u.b); \
    } \
    case 12: case 13: case 14:                           /* 生成器的 next / return / throw */ \
      return omni_js_gen_step_(self, a0, n->sel - 12); \
    case 15: return self;                               /* 迭代器的 [Symbol.iterator]：交回自己 */ \
    case 16: return omni_js_src_iter_(self);            /* 数组 / 串 / Map / Set 的 [Symbol.iterator] */ \
    case 18: omni_js_prom_settle_(n->a, 1, a0); return omni_dyn_undef();  /* resolve(p) */ \
    case 19: omni_js_prom_settle_(n->a, 2, a0); return omni_dyn_undef();  /* reject(p) */ \
    case 20: {                                          /* 跟随 thenable 那格作业 */ \
      LT pay = (LT)n->a.u.ref; \
      omni_js_prom_react_(pay->items[1], omni_js_nat_(18, pay->items[0]), \
                          omni_js_nat_(19, pay->items[0])); \
      return omni_dyn_undef(); \
    } \
    case 21: {                                          /* schedule 那格作业 */ \
      LT cb = (LT)n->a.u.ref; \
      omni_dyn pp = cb->items[0]; \
      omni_dyn child = cb->items[3]; \
      LT ss = omni_js_prom_slot_(pp, "$st", 3); \
      int64_t st = (int64_t)ss->items[0].u.r; \
      omni_dyn val = omni_js_prom_slot_(pp, "$val", 4)->items[0]; \
      omni_dyn h = st == 1 ? cb->items[1] : cb->items[2]; \
      if (h.tag != OMNI_DYN_FN) { omni_js_prom_settle_(child, st, val); return omni_dyn_undef(); } \
      LT ha = LT##_new(); \
      LT##_push(ha, val); \
      omni_dyn out = omni_js_call_this(h, omni_dyn_undef(), omni_js_arr_wrap(ha)); \
      if (omni_js_pending()) { \
        omni_js_prom_settle_(child, 2, omni_js_take_pending()); \
        return omni_dyn_undef(); \
      } \
      omni_js_prom_settle_(child, 1, out); \
      return omni_dyn_undef(); \
    } \
    case 22: case 23: {                                 /* async 的 tick（兑现 / 拒绝） */ \
      LT pay = (LT)n->a.u.ref; \
      omni_js_async_tick_(pay->items[0], pay->items[1], a0, n->sel == 22 ? 0 : 2); \
      return omni_dyn_undef(); \
    } \
    case 29: {                                          /* all 的每一格：兑现 */ \
      LT pay = (LT)n->a.u.ref; \
      LT st = (LT)pay->items[0].u.ref; \
      LT vals = (LT)st->items[1].u.ref; \
      vals->items[(int64_t)pay->items[1].u.r] = a0; \
      omni_js_comb_dec_(st); \
      return omni_dyn_undef(); \
    } \
    case 30: {                                          /* 直接 reject 这一格 promise */ \
      LT pay = (LT)n->a.u.ref; \
      omni_js_prom_settle_(pay->items[0], 2, a0); \
      return omni_dyn_undef(); \
    } \
    case 31: {                                          /* 直接 resolve 这一格 promise（race） */ \
      LT pay = (LT)n->a.u.ref; \
      omni_js_prom_settle_(pay->items[0], 1, a0); \
      return omni_dyn_undef(); \
    } \
    case 32: case 33: {                                 /* allSettled 的每一格 */ \
      LT pay = (LT)n->a.u.ref; \
      LT st = (LT)pay->items[0].u.ref; \
      LT vals = (LT)st->items[1].u.ref; \
      omni_dyn o = omni_js_obj_new(); \
      omni_js_obj_setk(o, omni_str_new("status", 6), \
                       omni_dyn_of_s16(omni_s16_of_utf8(n->sel == 32 \
                         ? omni_str_new("fulfilled", 9) : omni_str_new("rejected", 8)))); \
      omni_js_obj_setk(o, n->sel == 32 ? omni_str_new("value", 5) : omni_str_new("reason", 6), a0); \
      vals->items[(int64_t)pay->items[1].u.r] = o; \
      omni_js_comb_dec_(st); \
      return omni_dyn_undef(); \
    } \
    case 34: {                                          /* any 的每一格：拒绝 */ \
      LT pay = (LT)n->a.u.ref; \
      LT st = (LT)pay->items[0].u.ref; \
      LT errs = (LT)st->items[1].u.ref; \
      errs->items[(int64_t)pay->items[1].u.r] = a0; \
      LT cnt = (LT)st->items[2].u.ref; \
      double left = cnt->items[0].u.r - 1.0; \
      cnt->items[0] = omni_dyn_of_real(left); \
      if (left <= 0.0) omni_js_prom_settle_(st->items[0], 2, omni_js_agg_err_(st->items[1])); \
      return omni_dyn_undef(); \
    } \
    case 35:                                            /* Iterator.prototype.next 是抽象的 */ \
      omni_errorf("Iterator.prototype.next is abstract"); \
      return omni_dyn_undef(); \
    case 36: return omni_js_it_help_(0, self, omni_dyn_undef(), omni_js_it_count_(a0, "take")); \
    case 37: return omni_js_it_help_(1, self, omni_dyn_undef(), omni_js_it_count_(a0, "drop")); \
    case 38: return omni_js_it_help_(2, self, a0, 0); \
    case 39: return omni_js_it_help_(3, self, a0, 0); \
    case 40: return omni_js_it_help_(4, self, a0, 0); \
    case 41: {                                          /* toArray */ \
      LT out = LT##_new(); \
      for (;;) { \
        omni_dyn r = omni_js_iter_next(self); \
        if (omni_js_pending() || omni_js_it_done_(r)) return omni_js_arr_wrap(out); \
        LT##_push(out, omni_js_it_val_(r)); \
      } \
    } \
    case 42: case 43: case 44: case 45: case 46: { \
      /* 终结的那五格（forEach / reduce / some / every / find）：就地把上游拉完或短路，
         短路时关掉上游。回调收 (value, counter)，counter 从 0 起 —— reduce 少了初值时
         头一格当初值，于是它的 counter 从 1 起（规范如此）。 */ \
      double i = 0.0; \
      omni_dyn acc = args != NULL && args->len > 1 ? args->items[1] : omni_dyn_undef(); \
      if (n->sel == 43 && acc.tag == OMNI_DYN_UNDEF) { \
        omni_dyn r0 = omni_js_iter_next(self); \
        if (omni_js_pending()) return omni_dyn_undef(); \
        if (omni_js_it_done_(r0)) { \
          omni_errorf("reduce of empty iterator with no initial value"); \
          return omni_dyn_undef(); \
        } \
        acc = omni_js_it_val_(r0); \
        i = 1.0; \
      } \
      for (;;) { \
        LT ca = LT##_new(); \
        omni_dyn v, out; \
        omni_dyn r = omni_js_iter_next(self); \
        if (omni_js_pending()) return omni_dyn_undef(); \
        if (omni_js_it_done_(r)) { \
          if (n->sel == 43) return acc; \
          if (n->sel == 44) return omni_dyn_of_bool(false); \
          if (n->sel == 45) return omni_dyn_of_bool(true); \
          return omni_dyn_undef(); \
        } \
        v = omni_js_it_val_(r); \
        if (n->sel == 43) LT##_push(ca, acc); \
        LT##_push(ca, v); \
        LT##_push(ca, omni_dyn_of_real(i)); \
        out = omni_js_call_this(a0, omni_dyn_undef(), omni_js_arr_wrap(ca)); \
        if (omni_js_pending()) return omni_dyn_undef(); \
        i = i + 1.0; \
        if (n->sel == 43) { acc = out; continue; } \
        if (n->sel == 44 && omni_js_truthy(out)) { \
          omni_js_it_close_(self); \
          return omni_dyn_of_bool(true); \
        } \
        if (n->sel == 45 && !omni_js_truthy(out)) { \
          omni_js_it_close_(self); \
          return omni_dyn_of_bool(false); \
        } \
        if (n->sel == 46 && omni_js_truthy(out)) { omni_js_it_close_(self); return v; } \
      } \
    } \
    case 47: {                                          /* helper 自己的 next */ \
      LT fs = omni_js_prom_slot_(self, "$f", 2); \
      LT cs = omni_js_prom_slot_(self, "$c", 2); \
      LT is = omni_js_prom_slot_(self, "$i", 2); \
      LT ns = omni_js_prom_slot_(self, "$n", 2); \
      LT ins = omni_js_prom_slot_(self, "$in", 3); \
      int64_t kind = (int64_t)omni_js_prom_slot_(self, "$k", 2)->items[0].u.r; \
      omni_dyn up = omni_js_prom_slot_(self, "$up", 3)->items[0]; \
      omni_dyn fn = omni_js_prom_slot_(self, "$fn", 3)->items[0]; \
      omni_dyn r, v; \
      if (cs->items[0].u.r != 0.0 || fs->items[0].u.r != 0.0) { \
        return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
      } \
      if (kind == 0) {                                  /* take */ \
        if (ns->items[0].u.r <= 0.0) { \
          fs->items[0] = omni_dyn_of_real(1.0); \
          omni_js_it_close_(up); \
          return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
        } \
        ns->items[0] = omni_dyn_of_real(ns->items[0].u.r - 1.0); \
        r = omni_js_iter_next(up); \
        if (omni_js_pending() || omni_js_it_done_(r)) { \
          fs->items[0] = omni_dyn_of_real(1.0); \
          return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
        } \
        return omni_js_gen_res(omni_js_it_val_(r), omni_dyn_of_bool(false)); \
      } \
      if (kind == 1) {                                  /* drop */ \
        while (ns->items[0].u.r > 0.0) { \
          ns->items[0] = omni_dyn_of_real(ns->items[0].u.r - 1.0); \
          r = omni_js_iter_next(up); \
          if (omni_js_pending() || omni_js_it_done_(r)) { \
            fs->items[0] = omni_dyn_of_real(1.0); \
            return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
          } \
        } \
        r = omni_js_iter_next(up); \
        if (omni_js_pending() || omni_js_it_done_(r)) { \
          fs->items[0] = omni_dyn_of_real(1.0); \
          return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
        } \
        return omni_js_gen_res(omni_js_it_val_(r), omni_dyn_of_bool(false)); \
      } \
      if (kind == 2) {                                  /* map */ \
        LT ca = LT##_new(); \
        r = omni_js_iter_next(up); \
        if (omni_js_pending() || omni_js_it_done_(r)) { \
          fs->items[0] = omni_dyn_of_real(1.0); \
          return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
        } \
        LT##_push(ca, omni_js_it_val_(r)); \
        LT##_push(ca, is->items[0]); \
        v = omni_js_call_this(fn, omni_dyn_undef(), omni_js_arr_wrap(ca)); \
        is->items[0] = omni_dyn_of_real(is->items[0].u.r + 1.0); \
        return omni_js_gen_res(v, omni_dyn_of_bool(false)); \
      } \
      if (kind == 3) {                                  /* filter */ \
        for (;;) { \
          LT ca = LT##_new(); \
          bool keep; \
          r = omni_js_iter_next(up); \
          if (omni_js_pending() || omni_js_it_done_(r)) break; \
          v = omni_js_it_val_(r); \
          LT##_push(ca, v); \
          LT##_push(ca, is->items[0]); \
          keep = omni_js_truthy(omni_js_call_this(fn, omni_dyn_undef(), omni_js_arr_wrap(ca))); \
          is->items[0] = omni_dyn_of_real(is->items[0].u.r + 1.0); \
          if (omni_js_pending()) break; \
          if (keep) return omni_js_gen_res(v, omni_dyn_of_bool(false)); \
        } \
        fs->items[0] = omni_dyn_of_real(1.0); \
        return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
      } \
      for (;;) {                                        /* flatMap */ \
        LT ca = LT##_new(); \
        if (ins->items[0].tag != OMNI_DYN_UNDEF) { \
          omni_dyn ir = omni_js_iter_next(ins->items[0]); \
          if (omni_js_pending()) break; \
          if (!omni_js_it_done_(ir)) { \
            return omni_js_gen_res(omni_js_it_val_(ir), omni_dyn_of_bool(false)); \
          } \
          ins->items[0] = omni_dyn_undef(); \
        } \
        r = omni_js_iter_next(up); \
        if (omni_js_pending() || omni_js_it_done_(r)) break; \
        LT##_push(ca, omni_js_it_val_(r)); \
        LT##_push(ca, is->items[0]); \
        v = omni_js_call_this(fn, omni_dyn_undef(), omni_js_arr_wrap(ca)); \
        if (omni_js_pending()) break; \
        ins->items[0] = omni_js_it_up_(v); \
        is->items[0] = omni_dyn_of_real(is->items[0].u.r + 1.0); \
      } \
      fs->items[0] = omni_dyn_of_real(1.0); \
      return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
    } \
    case 48: {                                          /* helper 自己的 return：把上游也关掉 */ \
      LT cs = omni_js_prom_slot_(self, "$c", 2); \
      if (cs->items[0].u.r == 0.0) { \
        cs->items[0] = omni_dyn_of_real(1.0); \
        omni_js_it_close_(omni_js_prom_slot_(self, "$up", 3)->items[0]); \
      } \
      return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
    } \
    case 24: {                                          /* p.then(f, r) */ \
      omni_dyn a1t = args != NULL && args->len > 1 ? args->items[1] : omni_dyn_undef(); \
      return omni_js_prom_react_(self, a0, a1t); \
    } \
    case 25: return omni_js_prom_react_(self, omni_dyn_undef(), a0);  /* p.catch(r) */ \
    case 26: return omni_js_prom_react_(self, omni_js_nat_(27, a0), omni_js_nat_(28, a0)); \
    case 27: case 28: {                                 /* finally：跑一趟处理器，再原样传下去 */ \
      LT ha = LT##_new(); \
      omni_js_call_this(n->a, omni_dyn_undef(), omni_js_arr_wrap(ha)); \
      if (omni_js_pending()) return omni_dyn_undef(); \
      if (n->sel == 28) { omni_js_throw(a0); return omni_dyn_undef(); } \
      return a0; \
    } \
    case 17: {                                          /* 源迭代器的 next */ \
      omni_str sk = omni_js_pkey_(omni_js_name_("$src", 4)); \
      omni_str xk = omni_js_pkey_(omni_js_name_("$ix", 3)); \
      LT ss = self.tag == OMNI_DYN_OBJ ? omni_js_find_slot_(self, sk, NULL) : NULL; \
      LT xs = self.tag == OMNI_DYN_OBJ ? omni_js_find_slot_(self, xk, NULL) : NULL; \
      if (ss == NULL || xs == NULL) { \
        omni_js_type_err_c("this is not an iterator"); \
        return omni_dyn_undef(); \
      } \
      LT src = (LT)ss->items[0].u.ref; \
      int64_t ix = (int64_t)xs->items[0].u.r; \
      if (src == NULL || ix >= src->len) { \
        return omni_js_gen_res(omni_dyn_undef(), omni_dyn_of_bool(true)); \
      } \
      xs->items[0] = omni_dyn_of_real((double)(ix + 1)); \
      return omni_js_gen_res(src->items[ix], omni_dyn_of_bool(false)); \
    } \
    case 8: {                                           /* f.call(thisArg, …) */ \
      LT rest = LT##_new(); \
      for (int64_t i = 1; args != NULL && i < args->len; i++) LT##_push(rest, args->items[i]); \
      return omni_js_call_this(n->a, a0, omni_js_arr_wrap(rest)); \
    } \
    case 9: {                                           /* f.apply(thisArg, argsArray) */ \
      omni_dyn a1 = args != NULL && args->len > 1 ? args->items[1] : omni_dyn_undef(); \
      if (a1.tag == OMNI_DYN_UNDEF || a1.tag == OMNI_DYN_NULL) { \
        return omni_js_call_this(n->a, a0, omni_js_arr_wrap(LT##_new())); \
      } \
      if (a1.tag != OMNI_DYN_LIST) { \
        omni_js_type_err_c("apply expects an array of arguments"); \
        return omni_dyn_undef(); \
      } \
      return omni_js_call_this(n->a, a0, a1); \
    } \
    case 10: {                                          /* bind 出来的那一格：预置实参 + 定住的 this */ \
      LT bp = (LT)n->a.u.ref; \
      LT all = LT##_new(); \
      for (int64_t i = 4; i < bp->len; i++) LT##_push(all, bp->items[i]); \
      for (int64_t i = 0; args != NULL && i < args->len; i++) LT##_push(all, args->items[i]); \
      return omni_js_call_this(bp->items[0], bp->items[1], omni_js_arr_wrap(all)); \
    } \
    case 11: {                                          /* f.bind(thisArg, …预置) */ \
      int64_t pre = args == NULL || args->len == 0 ? 0 : args->len - 1; \
      omni_dyn tn = omni_js_obj_getk(n->a, omni_str_new("name", 4)); \
      omni_dyn tl = omni_js_obj_getk(n->a, omni_str_new("length", 6)); \
      double left = (tl.tag == OMNI_DYN_REAL ? tl.u.r : 0.0) - (double)pre; \
      if (left < 0.0) left = 0.0; \
      LT bp = LT##_new(); \
      LT##_push(bp, n->a); \
      LT##_push(bp, a0); \
      LT##_push(bp, omni_dyn_of_s16(omni_s16_cat(omni_s16_of_utf8(omni_str_new("bound ", 6)), \
                                                 omni_js_as_s16(tn)))); \
      LT##_push(bp, omni_dyn_of_real(left)); \
      for (int64_t i = 1; args != NULL && i < args->len; i++) LT##_push(bp, args->items[i]); \
      return omni_js_nat_(10, omni_js_arr_wrap(bp)); \
    } \
    case 7: {                                           /* 别的原型上的 get 陷阱 */ \
      omni_str nm = omni_s16_to_utf8(omni_js_as_s16(n->a)); \
      /* 陷阱的实参是 (目标, 键, 接收者)：**键是第二格**。从前这儿读的是 a0（目标），
         于是那句拒绝里印出来的"成员名"是 "[object Object]"，而照成员表查更是一定查不着。 */ \
      omni_dyn kd = args != NULL && args->len > 1 ? args->items[1] : a0; \
      omni_str k = omni_s16_to_utf8(omni_js_as_s16(omni_js_str(kd))); \
      /* 照成员表查一格：查着了就发一个"第 ix 格原型成员"的原生（载荷记着名字与形参个数），
         于是 `Array.prototype.map` / `[].map` 取出来是个能调的函数值，`.call` 也照旧成立。
         查不着照旧当场报 —— 那句话是"成员表缺一格"的固定签名。 */ \
      /* valueOf 不在成员表里（它不是一格 ABI 成员）：这个值域里它在任何原型上都只把接收者
         交回去，所以直接发那格现成的原生（sel 3）—— 与 prelude 里 numP / boolP 上挂的
         那两格一字不差。少这一支 `(5).valueOf` 在这条腿上是 undefined，而 JS 那条腿是函数。 */ \
      if (k.len == 7 && memcmp(k.p, "valueOf", 7) == 0) return omni_js_nat_(3, omni_dyn_undef()); \
      /* 原型身上那格 constructor（规范如此）：`[].constructor === Array` 靠它。 */ \
      if (k.len == 11 && memcmp(k.p, "constructor", 11) == 0) return omni_js_realm_ctor(nm); \
      /* 原始值那一族的 Symbol.iterator（数组 / 串 / Map / Set）：交出一格真迭代器对象。
         手写协议与 yield* [1,2] 落在这一格；for-of 与展开走的是 js_iter 那条快路。 */ \
      if (kd.tag == OMNI_DYN_SYM \
          && kd.u.ref == omni_js_sym_wk(omni_str_new("iterator", 8)).u.ref) { \
        return omni_js_nat_(16, omni_dyn_undef()); \
      } \
      if (omni_js_pm_find_ != NULL) { \
        int64_t argc = 0; \
        int64_t ix = omni_js_pm_find_(nm, k, &argc); \
        if (ix >= 0) { \
          LT pp = LT##_new(); \
          LT##_push(pp, omni_dyn_of_s16(omni_s16_of_utf8(k))); \
          LT##_push(pp, omni_dyn_of_real((double)argc)); \
          return omni_js_nat_(OMNI_JS_PM_SEL + ix, omni_js_arr_wrap(pp)); \
        } \
        /* 表里没有这个名字：在这个值域里它**本来就不存在**，答 undefined 才是规范的答案
           （`[].zork`）。只有"成员表里有、可 C 那侧还没落地"（号 -2）才当场报。 */ \
        if (ix == -1) return omni_dyn_undef(); \
      } \
      omni_errorf("backend-c: reading '%.*s' off %.*s.prototype — 内建原型上的成员还没搬到 " \
                  "C 那条腿（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器", \
                  (int)k.len, k.p, (int)nm.len, nm.p); \
      return omni_dyn_undef(); \
    } \
    default: { \
      /* 内建构造器当值调（`const A = Array; A(3)`）：只做得了这几格 —— Function / Map /
         Set / Date 的实参面这条腿上还没有，当场报（与 prelude 的 no() 一字不差）。 */ \
      if (n->sel >= OMNI_JS_CTOR_SEL) { \
        int ci = (int)(n->sel - OMNI_JS_CTOR_SEL); \
        int64_t na = args == NULL ? 0 : args->len; \
        omni_dyn a1 = na > 1 ? args->items[1] : omni_dyn_undef(); \
        switch (ci) { \
          case 0: /* Object */ \
            if (a0.tag == OMNI_DYN_UNDEF || a0.tag == OMNI_DYN_NULL) return omni_js_obj_new(); \
            if (omni_js_is_object(a0) || a0.tag == OMNI_DYN_LIST) return a0; \
            omni_errorf("Object(primitive) would need a wrapper object; not supported"); \
            return omni_dyn_undef(); \
          case 2: { /* Array */ \
            if (na == 1) return omni_js_arr_new_n(a0); \
            LT l = LT##_new(); \
            for (int64_t i = 0; i < na; i++) LT##_push(l, args->items[i]); \
            return omni_js_arr_wrap(l); \
          } \
          /* omni_js_str（不是 str_v）：str_v 住在 STR_ARR 段、排在这一段后头。自带 toString
             的对象照旧调得到 —— to_s16 那儿过的是 ToPrimitive 钩子。 */ \
          case 3: return na == 0 ? omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("", 0))) \
                                 : omni_js_str(a0); \
          case 4: return na == 0 ? omni_dyn_of_real(0.0) : omni_js_num_of(a0); \
          case 5: return omni_dyn_of_bool(omni_js_truthy(a0)); \
          case 6: return omni_js_sym_new(a0); \
          case 7: return omni_js_re_new(a0, a1); \
          default: \
            omni_errorf("'%s' as a value cannot be called here; call it by name instead", \
                        omni_js_ctor_nm_[ci]); \
            return omni_dyn_undef(); \
        } \
      } \
      if (n->sel >= OMNI_JS_PM_SEL && omni_js_pm_call_ != NULL) { \
        return omni_js_pm_call_(n->sel - OMNI_JS_PM_SEL, args, self); \
      } \
      omni_errorf("backend-c: 未知的原生选择子 %lld（内部不一致）", (long long)n->sel); \
      return omni_dyn_undef(); \
    } \
  } \
} \
static omni_dyn omni_js_nat_(int64_t sel, omni_dyn a) { \
  struct omni_js_nat_s *n = (struct omni_js_nat_s *)omni_alloc(sizeof *n); \
  n->fp = (omni_fnptr)omni_js_nat_call_; \
  n->sel = sel; \
  n->a = a; \
  return omni_dyn_of_fn((omni_fn)n); \
} \
/* realm 上那几格原型。名字与 prelude 的 $js_realm_proto 那个 switch 一一对应；认不出来的
   名字**当场报**，不给一格空对象。 */ \
static omni_dyn omni_js_realm_tbl_[14]; \
static int omni_js_realm_ix_(omni_str name) { \
  /* Generator / Iterator 排在最后两格：生成器那一族（ADR-0020 P2）落在 C 上要它们 */ \
  static const char *names[14] = { "Object", "Function", "Array", "String", "Number", \
    "Boolean", "Symbol", "Error", "RegExp", "Map", "Set", "Promise", "Generator", "Iterator" }; \
  for (int i = 0; i < 14; i++) { \
    int64_t n = (int64_t)strlen(names[i]); \
    if (name.len == n && memcmp(name.p, names[i], (size_t)n) == 0) return i; \
  } \
  return -1; \
} \
static omni_dyn omni_js_realm_proto(omni_str name) { \
  int ix = omni_js_realm_ix_(name); \
  if (ix < 0) { \
    omni_errorf("backend-c: %.*s.prototype — realm 上这一格还没搬到 C 那条腿" \
                "（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器", \
                (int)name.len, name.p); \
    return omni_dyn_undef(); \
  } \
  if (omni_js_realm_tbl_[ix].tag == OMNI_DYN_OBJ) return omni_js_realm_tbl_[ix]; \
  if (ix == 0) { \
    /* Object.prototype：原型是 null（链的顶），成员按规范 20.1.3 挂全，都不可枚举 */ \
    omni_dyn p = omni_js_new_bare_(omni_dyn_null()); \
    omni_js_realm_tbl_[0] = p; \
    omni_js_def_data_(p, omni_js_name_("toString", 8), omni_js_nat_(1, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(p, omni_js_name_("toLocaleString", 14), omni_js_nat_(2, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(p, omni_js_name_("valueOf", 7), omni_js_nat_(3, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(p, omni_js_name_("hasOwnProperty", 14), omni_js_nat_(4, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(p, omni_js_name_("isPrototypeOf", 13), omni_js_nat_(5, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(p, omni_js_name_("propertyIsEnumerable", 20), \
                      omni_js_nat_(6, omni_dyn_undef()), true, false, true); \
    /* constructor 那一格（规范 20.1.3.1）：`({}).constructor === Object` 靠它。
       别的原型上这一格由 get 陷阱答，只有 Object.prototype 是真对象、要真坐一格。
       这儿回头调 realm_ctor 不会打转：realm_tbl_[0] 在上面已经填过了。 */ \
    omni_js_def_data_(p, omni_js_name_("constructor", 11), \
                      omni_js_realm_ctor(omni_str_new("Object", 6)), true, false, true); \
    return p; \
  } \
  /* Generator.prototype（ADR-0020 P2）：**真对象**，三格原生 next / return / throw 都落到
     同一个 gen_step（mode 0 / 1 / 2），再加一格 [Symbol.iterator] 交回自己。
     它自己的原型是 Iterator.prototype ——那格是"读成员就报"的代理，于是 ES2025 那批 helper
     （map / take …）在这条腿上是一句响错，不是静静的 undefined。 */ \
  /* Promise.prototype（ADR-0020 P2）：真对象，三格原生 then / catch / finally 都落到 react。 */ \
  if (ix == 11) { \
    omni_dyn pp = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Object", 6))); \
    omni_js_realm_tbl_[11] = pp; \
    omni_js_def_data_(pp, omni_js_name_("then", 4), omni_js_nat_(24, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(pp, omni_js_name_("catch", 5), omni_js_nat_(25, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(pp, omni_js_name_("finally", 7), omni_js_nat_(26, omni_dyn_undef()), \
                      true, false, true); \
    return pp; \
  } \
  if (ix == 12) { \
    omni_dyn gp = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Iterator", 8))); \
    omni_js_realm_tbl_[12] = gp; \
    omni_js_def_data_(gp, omni_js_name_("next", 4), omni_js_nat_(12, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(gp, omni_js_name_("return", 6), omni_js_nat_(13, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(gp, omni_js_name_("throw", 5), omni_js_nat_(14, omni_dyn_undef()), \
                      true, false, true); \
    omni_js_def_data_(gp, omni_js_sym_wk(omni_str_new("iterator", 8)), \
                      omni_js_nat_(15, omni_dyn_undef()), true, false, true); \
    return gp; \
  } \
  /* Iterator.prototype（ES2025）：**真对象**，next 是抽象的，另外 11 格是迭代器 helper。
     惰性的五格（take / drop / map / filter / flatMap）交一格 helper 对象回去，
     终结的六格（toArray / forEach / reduce / some / every / find）就地把上游拉完或短路。
     [Symbol.iterator] 交回自己 —— 于是 helper 与生成器都能直接进 for-of 与展开。 */ \
  if (ix == 13) { \
    static const char *inms[11] = { "take", "drop", "map", "filter", "flatMap", "toArray", \
                                    "forEach", "reduce", "some", "every", "find" }; \
    static const int64_t inls[11] = { 4, 4, 3, 6, 7, 7, 7, 6, 4, 5, 4 }; \
    int k; \
    omni_dyn ip = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Object", 6))); \
    omni_js_realm_tbl_[13] = ip; \
    omni_js_def_data_(ip, omni_js_name_("next", 4), omni_js_nat_(35, omni_dyn_undef()), \
                      true, false, true); \
    for (k = 0; k < 11; k++) { \
      omni_js_def_data_(ip, omni_js_name_(inms[k], inls[k]), \
                        omni_js_nat_(36 + k, omni_dyn_undef()), true, false, true); \
    } \
    omni_js_def_data_(ip, omni_js_sym_wk(omni_str_new("iterator", 8)), \
                      omni_js_nat_(15, omni_dyn_undef()), true, false, true); \
    return ip; \
  } \
  /* 别的原型：一格带 get 陷阱的代理，读成员当场报 —— 同一性照旧成立（instanceof 只比它） */ \
  omni_dyn h = omni_js_new_bare_(omni_dyn_null()); \
  omni_dyn nm = omni_dyn_of_s16(omni_s16_of_utf8(name)); \
  omni_js_def_data_(h, omni_js_name_("get", 3), omni_js_nat_(7, nm), true, false, true); \
  /* 原型自己的原型是 Object.prototype（规范如此）—— 少了这一条，`[] instanceof Object`
     会静静地给 false（链走到 Array.prototype 就断了）。 */ \
  omni_dyn objp = omni_js_realm_proto(omni_str_new("Object", 6)); \
  omni_dyn px = omni_js_new_bare_(objp); \
  omni_js_objv *ov = (omni_js_objv *)px.u.ref; \
  ov->px_t = omni_js_new_bare_(objp); \
  ov->px_h = h; \
  omni_js_realm_tbl_[ix] = px; \
  return px; \
} \
/* 生成器（ADR-0020 P2）。状态机的改写在前端（frontend-js/genfn.js）就做完了，运行时这一侧
   只有三格：一格带 $stp（状态机闭包）/ $gst（0 没开始 / 1 跑过 / 2 完了）两槽的真对象、
   一格 {value, done}、以及驱动它的 gen_step。规则照 prelude 的 $js_gen_step 逐条对齐。 */ \
/* 原始值那一族的 Symbol.iterator 交出来的**真迭代器对象**（与 prelude 的 $js_it_src 对应）：
   先把来源摊成一条 list（omni_js_iter），再按下标喂。next 与 [Symbol.iterator] 直接坐在
   这一格自己身上，不另立一格原型 —— 这条腿上唯一可观察的差别是它们算自有属性。
   for-of 与展开走的是 js_iter 那条快路、不经过这儿；手写协议与 yield* [1,2] 才落到这一格。 */ \
static omni_dyn omni_js_src_iter_(omni_dyn v) { \
  omni_dyn it = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Object", 6))); \
  omni_js_def_data_(it, omni_js_name_("$src", 4), omni_js_iter(v), true, false, true); \
  omni_js_def_data_(it, omni_js_name_("$ix", 3), omni_dyn_of_real(0.0), true, false, true); \
  omni_js_def_data_(it, omni_js_name_("next", 4), omni_js_nat_(17, omni_dyn_undef()), \
                    true, false, true); \
  omni_js_def_data_(it, omni_js_sym_wk(omni_str_new("iterator", 8)), \
                    omni_js_nat_(15, omni_dyn_undef()), true, false, true); \
  return it; \
} \
/* ES2025 的迭代器 helper（`Iterator.prototype` 上那 11 格，与 prelude 的 $js_it_* 逐条对齐）。
   这条腿上没有宿主闭包，所以每一格**惰性** helper 都是一格真对象，状态全摊在槽里：
     $k 种类（0 take / 1 drop / 2 map / 3 filter / 4 flatMap）、$up 上游迭代器、
     $fn 回调、$n 还要几格（take / drop 用）、$i 计数器、$f 上游完了没、$c 自己关了没、
     $in flatMap 的内层。
   next / return 两格原生（sel 47 / 48）坐在它**自己身上**（与 omni_js_src_iter_ 同一个做法，
   都是不可枚举的，所以 keys / JSON 上看不见）。return 要把上游也关掉 —— 少这一格，
   `g().map(f).take(3)` 拉完之后生成器的 finally 不会跑。 */ \
static omni_dyn omni_js_it_up_(omni_dyn v) { \
  return v.tag == OMNI_DYN_OBJ ? omni_js_iter_proto(v) : omni_js_src_iter_(v); \
} \
static void omni_js_it_close_(omni_dyn it) { \
  omni_dyn rf; \
  if (it.tag != OMNI_DYN_OBJ) return; \
  rf = omni_js_obj_get(it, omni_js_name_("return", 6)); \
  if (rf.tag == OMNI_DYN_FN) omni_js_call_this(rf, it, omni_js_arr_wrap(LT##_new())); \
} \
static bool omni_js_it_done_(omni_dyn r) { \
  return omni_js_truthy(omni_js_obj_get(r, omni_js_name_("done", 4))); \
} \
static omni_dyn omni_js_it_val_(omni_dyn r) { \
  return omni_js_obj_get(r, omni_js_name_("value", 5)); \
} \
static int64_t omni_js_it_count_(omni_dyn n, const char *who) { \
  double d = n.tag == OMNI_DYN_UNDEF ? -1.0 : (double)omni_js_arr_i(n); \
  if (!(d >= 0.0)) omni_errorf("%s count must not be negative", who); \
  return (int64_t)d; \
} \
static omni_dyn omni_js_it_help_(int64_t kind, omni_dyn up, omni_dyn fn, int64_t n) { \
  omni_dyn h = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Iterator", 8))); \
  omni_js_def_data_(h, omni_js_name_("$k", 2), omni_dyn_of_real((double)kind), true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$up", 3), up, true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$fn", 3), fn, true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$n", 2), omni_dyn_of_real((double)n), true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$i", 2), omni_dyn_of_real(0.0), true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$f", 2), omni_dyn_of_real(0.0), true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$c", 2), omni_dyn_of_real(0.0), true, false, true); \
  omni_js_def_data_(h, omni_js_name_("$in", 3), omni_dyn_undef(), true, false, true); \
  omni_js_def_data_(h, omni_js_name_("next", 4), omni_js_nat_(47, omni_dyn_undef()), \
                    true, false, true); \
  omni_js_def_data_(h, omni_js_name_("return", 6), omni_js_nat_(48, omni_dyn_undef()), \
                    true, false, true); \
  return h; \
} \
/* 作业队列（微任务，ADR-0020 P2）：一格静态 list + 一个游标（不 shift，省得每次搬）。
   这个值域里没有事件循环 —— 降级器在 main 末尾补一句 js_jobs_run 把它排空。 */ \
static LT omni_js_jobq_; \
static int64_t omni_js_jobq_at_; \
static void omni_js_job_(omni_dyn f) { \
  if (omni_js_jobq_ == NULL) omni_js_jobq_ = LT##_new(); \
  LT##_push(omni_js_jobq_, f); \
} \
static omni_dyn omni_js_jobs_run(void) { \
  while (omni_js_jobq_ != NULL && omni_js_jobq_at_ < omni_js_jobq_->len) { \
    omni_dyn f = omni_js_jobq_->items[omni_js_jobq_at_]; \
    omni_js_jobq_at_ = omni_js_jobq_at_ + 1; \
    omni_js_call_this(f, omni_dyn_undef(), omni_js_arr_wrap(LT##_new())); \
    /* 作业里抛出来的东西没人接手（JS 里那是 unhandledRejection）：清掉槽接着走 */ \
    if (omni_js_pending()) omni_js_take_pending(); \
  } \
  return omni_dyn_undef(); \
} \
static LT omni_js_prom_slot_(omni_dyn p, const char *nm, int64_t n) { \
  if (p.tag != OMNI_DYN_OBJ) return NULL; \
  return omni_js_find_slot_(p, omni_js_pkey_(omni_js_name_(nm, n)), NULL); \
} \
static bool omni_js_prom_is_(omni_dyn v) { return omni_js_prom_slot_(v, "$st", 3) != NULL; } \
static omni_dyn omni_js_prom_new_(void) { \
  omni_dyn p = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Promise", 7))); \
  omni_js_def_data_(p, omni_js_name_("$st", 3), omni_dyn_of_real(0.0), true, false, true); \
  omni_js_def_data_(p, omni_js_name_("$val", 4), omni_dyn_undef(), true, false, true); \
  omni_js_def_data_(p, omni_js_name_("$cbs", 4), omni_js_arr_wrap(LT##_new()), true, false, true); \
  return p; \
} \
/* 排一格作业：跑的时候按 $st 选 f / r，没有那格处理器就把状态直接传给 child，
   处理器自己抛了就 reject child（见 sel 21）。 */ \
static void omni_js_prom_sched_(omni_dyn p, omni_dyn f, omni_dyn r, omni_dyn child) { \
  LT cb = LT##_new(); \
  LT##_push(cb, p); \
  LT##_push(cb, f); \
  LT##_push(cb, r); \
  LT##_push(cb, child); \
  omni_js_job_(omni_js_nat_(21, omni_js_arr_wrap(cb))); \
} \
/* 注册一对处理器、交出子 promise。**已经结算的也要排队**、不能当场调 ——
   微任务的次序（先把同步代码跑完）就是靠这一条。 */ \
static omni_dyn omni_js_prom_react_(omni_dyn p, omni_dyn f, omni_dyn r) { \
  if (!omni_js_prom_is_(p)) { \
    omni_js_type_err_c("this is not a Promise"); \
    return omni_dyn_undef(); \
  } \
  omni_dyn child = omni_js_prom_new_(); \
  LT ss = omni_js_prom_slot_(p, "$st", 3); \
  if ((int64_t)ss->items[0].u.r == 0) { \
    LT cbs = (LT)omni_js_prom_slot_(p, "$cbs", 4)->items[0].u.ref; \
    LT one = LT##_new(); \
    LT##_push(one, f); \
    LT##_push(one, r); \
    LT##_push(one, child); \
    LT##_push(cbs, omni_js_arr_wrap(one)); \
  } else { \
    omni_js_prom_sched_(p, f, r, child); \
  } \
  return child; \
} \
static void omni_js_prom_settle_(omni_dyn p, int64_t st, omni_dyn val) { \
  LT ss = omni_js_prom_slot_(p, "$st", 3); \
  if (ss == NULL || (int64_t)ss->items[0].u.r != 0) return; \
  /* resolve 收到一格 promise 就跟着它走，而且**多花一拍**（规范的
     NewPromiseResolveThenableJob）—— 少这一拍两条独立链的交错次序就与 qjs 不同。 */ \
  if (st == 1 && omni_js_prom_is_(val)) { \
    LT pay = LT##_new(); \
    LT##_push(pay, p); \
    LT##_push(pay, val); \
    omni_js_job_(omni_js_nat_(20, omni_js_arr_wrap(pay))); \
    return; \
  } \
  ss->items[0] = omni_dyn_of_real((double)st); \
  omni_js_prom_slot_(p, "$val", 4)->items[0] = val; \
  LT cbs = (LT)omni_js_prom_slot_(p, "$cbs", 4)->items[0].u.ref; \
  for (int64_t i = 0; i < cbs->len; i++) { \
    LT one = (LT)cbs->items[i].u.ref; \
    omni_js_prom_sched_(p, one->items[0], one->items[1], one->items[2]); \
  } \
  cbs->len = 0; \
} \
static omni_dyn omni_js_promise_resolved(omni_dyn v) { \
  if (omni_js_prom_is_(v)) return v; \
  omni_dyn p = omni_js_prom_new_(); \
  omni_js_prom_settle_(p, 1, v); \
  return p; \
} \
static omni_dyn omni_js_promise_rejected(omni_dyn e) { \
  omni_dyn p = omni_js_prom_new_(); \
  omni_js_prom_settle_(p, 2, e); \
  return p; \
} \
static omni_dyn omni_js_promise_new(omni_dyn exec) { \
  omni_dyn p = omni_js_prom_new_(); \
  LT a = LT##_new(); \
  LT##_push(a, omni_js_nat_(18, p)); \
  LT##_push(a, omni_js_nat_(19, p)); \
  omni_js_call_this(exec, omni_dyn_undef(), omni_js_arr_wrap(a)); \
  /* executor 自己抛了：照规范当作 reject */ \
  if (omni_js_pending()) omni_js_prom_settle_(p, 2, omni_js_take_pending()); \
  return p; \
} \
/* await 那一步：把结果接回状态机（兑现走 mode 0、拒绝走 mode 2） */ \
static void omni_js_await_then_(omni_dyn p, omni_dyn step, omni_dyn v) { \
  LT pay = LT##_new(); \
  LT##_push(pay, p); \
  LT##_push(pay, step); \
  omni_js_prom_react_(omni_js_promise_resolved(v), \
                      omni_js_nat_(22, omni_js_arr_wrap(pay)), \
                      omni_js_nat_(23, omni_js_arr_wrap(pay))); \
} \
static void omni_js_async_tick_(omni_dyn p, omni_dyn step, omni_dyn v, int64_t mode) { \
  LT a = LT##_new(); \
  LT##_push(a, v); \
  LT##_push(a, omni_dyn_of_real((double)mode)); \
  omni_dyn r = omni_js_call_this(step, omni_dyn_undef(), omni_js_arr_wrap(a)); \
  /* 体里抛出来的：有 catch / finally 接手就送回去（mode 2），没有就成了这格 promise 的 reject */ \
  if (omni_js_pending()) { \
    LT a2 = LT##_new(); \
    LT##_push(a2, omni_js_take_pending()); \
    LT##_push(a2, omni_dyn_of_real(2.0)); \
    r = omni_js_call_this(step, omni_dyn_undef(), omni_js_arr_wrap(a2)); \
    if (omni_js_pending()) { omni_js_prom_settle_(p, 2, omni_js_take_pending()); return; } \
  } \
  if (omni_js_truthy(omni_js_obj_getk(r, omni_str_new("done", 4)))) { \
    omni_js_prom_settle_(p, 1, omni_js_obj_getk(r, omni_str_new("value", 5))); \
    return; \
  } \
  omni_js_await_then_(p, step, omni_js_obj_getk(r, omni_str_new("value", 5))); \
} \
/* Promise 的组合器（all / allSettled / race / try）。每一格都要"几格共享的可变状态"，
   而这条腿上没有宿主闭包 —— 所以状态就是一格 list：[p, vals, cnt]（cnt 自己也是一格
   单元素 list，当可变的计数盒用），每个 per-item 的原生载荷是 [状态, 下标]。 */ \
static void omni_js_comb_dec_(LT st) { \
  LT cnt = (LT)st->items[2].u.ref; \
  double left = cnt->items[0].u.r - 1.0; \
  cnt->items[0] = omni_dyn_of_real(left); \
  if (left <= 0.0) omni_js_prom_settle_(st->items[0], 1, st->items[1]); \
} \
static omni_dyn omni_js_comb_state_(omni_dyn p, int64_t n) { \
  LT vals = LT##_new(); \
  for (int64_t i = 0; i < n; i++) LT##_push(vals, omni_dyn_undef()); \
  LT cnt = LT##_new(); \
  LT##_push(cnt, omni_dyn_of_real((double)n)); \
  LT st = LT##_new(); \
  LT##_push(st, p); \
  LT##_push(st, omni_js_arr_wrap(vals)); \
  LT##_push(st, omni_js_arr_wrap(cnt)); \
  return omni_js_arr_wrap(st); \
} \
static omni_dyn omni_js_comb_pay_(omni_dyn st, int64_t i) { \
  LT pay = LT##_new(); \
  LT##_push(pay, st); \
  LT##_push(pay, omni_dyn_of_real((double)i)); \
  return omni_js_arr_wrap(pay); \
} \
/* Promise.any 全拒时交出来的那一格 AggregateError。形状照 prelude 的 $js_promise_any：
   $cls 链是 ["AggregateError", "Error"]、message 空串、errors 是**按下标**排好的那条表。 */ \
static omni_dyn omni_js_agg_err_(omni_dyn errs) { \
  LT cls = LT##_new(); \
  LT##_push(cls, omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("AggregateError", 14)))); \
  LT##_push(cls, omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("Error", 5)))); \
  omni_dyn e = omni_js_err_new(omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("", 0))), \
                               omni_js_arr_wrap(cls), omni_dyn_undef()); \
  omni_js_obj_set(e, omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("errors", 6))), errs); \
  return e; \
} \
static omni_dyn omni_js_promise_all(omni_dyn items) { \
  omni_dyn xs = omni_js_iter(items); \
  LT l = (LT)xs.u.ref; \
  omni_dyn p = omni_js_prom_new_(); \
  int64_t n = l == NULL ? 0 : l->len; \
  if (n == 0) { \
    omni_js_prom_settle_(p, 1, omni_js_arr_wrap(LT##_new())); \
    return p; \
  } \
  omni_dyn st = omni_js_comb_state_(p, n); \
  LT pl = LT##_new(); \
  LT##_push(pl, p); \
  omni_dyn rej = omni_js_nat_(30, omni_js_arr_wrap(pl)); \
  for (int64_t i = 0; i < n; i++) { \
    omni_js_prom_react_(omni_js_promise_resolved(l->items[i]), \
                        omni_js_nat_(29, omni_js_comb_pay_(st, i)), rej); \
  } \
  return p; \
} \
static omni_dyn omni_js_promise_all_settled(omni_dyn items) { \
  omni_dyn xs = omni_js_iter(items); \
  LT l = (LT)xs.u.ref; \
  omni_dyn p = omni_js_prom_new_(); \
  int64_t n = l == NULL ? 0 : l->len; \
  if (n == 0) { \
    omni_js_prom_settle_(p, 1, omni_js_arr_wrap(LT##_new())); \
    return p; \
  } \
  omni_dyn st = omni_js_comb_state_(p, n); \
  for (int64_t i = 0; i < n; i++) { \
    omni_js_prom_react_(omni_js_promise_resolved(l->items[i]), \
                        omni_js_nat_(32, omni_js_comb_pay_(st, i)), \
                        omni_js_nat_(33, omni_js_comb_pay_(st, i))); \
  } \
  return p; \
} \
static omni_dyn omni_js_promise_race(omni_dyn items) { \
  omni_dyn xs = omni_js_iter(items); \
  LT l = (LT)xs.u.ref; \
  omni_dyn p = omni_js_prom_new_(); \
  LT pl = LT##_new(); \
  LT##_push(pl, p); \
  omni_dyn pay = omni_js_arr_wrap(pl); \
  for (int64_t i = 0; l != NULL && i < l->len; i++) { \
    omni_js_prom_react_(omni_js_promise_resolved(l->items[i]), \
                        omni_js_nat_(31, pay), omni_js_nat_(30, pay)); \
  } \
  return p; \
} \
/* Promise.any：与 all 镜像 —— 第一个**兑现**的赢，全拒才结算，errors 按下标排好。
   兑现那一半可以直接借 race 的 sel 31（载荷是 [p]）；拒绝那一半自己一格 sel 34，
   因为倒数到零时要交的是 AggregateError 而不是那条 vals 表。 */ \
static omni_dyn omni_js_promise_any(omni_dyn items) { \
  omni_dyn xs = omni_js_iter(items); \
  LT l = (LT)xs.u.ref; \
  omni_dyn p = omni_js_prom_new_(); \
  int64_t n = l == NULL ? 0 : l->len; \
  if (n == 0) { \
    omni_js_prom_settle_(p, 2, omni_js_agg_err_(omni_js_arr_wrap(LT##_new()))); \
    return p; \
  } \
  omni_dyn st = omni_js_comb_state_(p, n); \
  LT pl = LT##_new(); \
  LT##_push(pl, p); \
  omni_dyn res = omni_js_nat_(31, omni_js_arr_wrap(pl)); \
  for (int64_t i = 0; i < n; i++) { \
    omni_js_prom_react_(omni_js_promise_resolved(l->items[i]), \
                        res, omni_js_nat_(34, omni_js_comb_pay_(st, i))); \
  } \
  return p; \
} \
static omni_dyn omni_js_promise_try(omni_dyn f) { \
  omni_dyn p = omni_js_prom_new_(); \
  omni_dyn v = omni_js_call_this(f, omni_dyn_undef(), omni_js_arr_wrap(LT##_new())); \
  if (omni_js_pending()) { omni_js_prom_settle_(p, 2, omni_js_take_pending()); return p; } \
  omni_js_prom_settle_(p, 1, v); \
  return p; \
} \
static omni_dyn omni_js_async_run(omni_dyn step) { \
  omni_dyn p = omni_js_prom_new_(); \
  /* 第一段是**同步**跑的（规范如此：async 函数体一直跑到第一个 await） */ \
  omni_js_async_tick_(p, step, omni_dyn_undef(), 0); \
  return p; \
} \
static omni_dyn omni_js_gen_res(omni_dyn v, omni_dyn done) { \
  omni_dyn o = omni_js_obj_new(); \
  omni_js_obj_setk(o, omni_str_new("value", 5), v); \
  omni_js_obj_setk(o, omni_str_new("done", 4), omni_dyn_of_bool(omni_js_truthy(done))); \
  return o; \
} \
/* await 那一步的收尾（ADR-0020 P2）：与 gen_res 同一格形状，多一个 $aw 标记。 */ \
static omni_dyn omni_js_gen_awt(omni_dyn v) { \
  omni_dyn o = omni_js_gen_res(v, omni_dyn_of_bool(false)); \
  omni_js_obj_setk(o, omni_str_new("$aw", 3), omni_dyn_of_bool(true)); \
  return o; \
} \
static omni_dyn omni_js_gen_new(omni_dyn step) { \
  omni_dyn g = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Generator", 9))); \
  omni_js_def_data_(g, omni_js_name_("$stp", 4), step, true, false, true); \
  omni_js_def_data_(g, omni_js_name_("$gst", 4), omni_dyn_of_real(0.0), true, false, true); \
  return g; \
} \
static omni_dyn omni_js_gen_step_(omni_dyn g, omni_dyn v, int64_t mode) { \
  /* find_slot_ 收的是**加了标签的键**（omni_js_pkey_ 发的那种），不是名字本身 */ \
  omni_str sk = omni_js_pkey_(omni_js_name_("$stp", 4)); \
  omni_str gk = omni_js_pkey_(omni_js_name_("$gst", 4)); \
  LT sl = g.tag == OMNI_DYN_OBJ ? omni_js_find_slot_(g, sk, NULL) : NULL; \
  LT gs = g.tag == OMNI_DYN_OBJ ? omni_js_find_slot_(g, gk, NULL) : NULL; \
  if (sl == NULL || gs == NULL) { \
    omni_js_type_err_c("this is not a generator"); \
    return omni_dyn_undef(); \
  } \
  double st = gs->items[0].tag == OMNI_DYN_REAL ? gs->items[0].u.r : 0.0; \
  /* 没开始就 return/throw，或者已经跑完了：**不进体**（规范如此）。 */ \
  if (st == 2.0 || (st == 0.0 && mode != 0)) { \
    gs->items[0] = omni_dyn_of_real(2.0); \
    if (mode == 2) { omni_js_throw(v); return omni_dyn_undef(); } \
    return omni_js_gen_res(mode == 1 ? v : omni_dyn_undef(), omni_dyn_of_bool(true)); \
  } \
  gs->items[0] = omni_dyn_of_real(1.0); \
  LT a1 = LT##_new(); \
  LT##_push(a1, v); \
  LT##_push(a1, omni_dyn_of_real((double)mode)); \
  omni_dyn r = omni_js_call_this(sl->items[0], omni_dyn_undef(), omni_js_arr_wrap(a1)); \
  /* 体里抛出来的东西在挂起槽里：机器里还有活着的 catch 就用 mode 3 送回去接着跑
     （genfn.js 的 tryCatch）；没有的话机器原样抛回来，生成器就此完。 */ \
  if (omni_js_pending()) { \
    LT a2 = LT##_new(); \
    LT##_push(a2, omni_js_take_pending()); \
    LT##_push(a2, omni_dyn_of_real(2.0)); \
    r = omni_js_call_this(sl->items[0], omni_dyn_undef(), omni_js_arr_wrap(a2)); \
    if (omni_js_pending()) { gs->items[0] = omni_dyn_of_real(2.0); return omni_dyn_undef(); } \
  } \
  if (omni_js_truthy(omni_js_obj_getk(r, omni_str_new("done", 4)))) { \
    gs->items[0] = omni_dyn_of_real(2.0); \
  } \
  return r; \
} \
/* 内建构造器**当值用**（ADR-0020 P1-f 的第二半）：`const A = Array`、`[].constructor === Array`。
   与 realm_proto 同一个路子 —— 名字是编译期常量、每个 realm 一份，所以取两次是同一个值、
   `===` 为真。它是一格原生（sel 从 OMNI_JS_CTOR_SEL 起）；prototype 那一格**预先坐进**
   fnproto 旁表，于是 `A.prototype` 与 `x instanceof A` 都对。
   静态面（`Array.isArray` / `Object.keys`）挂不上去 —— 函数在这个值域里还不是真对象，
   那些名字只能从成员写法取。这一格与 JS 那条腿是同一条边界（写在 prelude 的 $js_mk_ctors 上）。 */ \
static omni_dyn omni_js_realm_ctor(omni_str name) { \
  int ix = -1; \
  for (int i = 0; i < 11; i++) { \
    int64_t l = (int64_t)strlen(omni_js_ctor_nm_[i]); \
    if (name.len == l && memcmp(name.p, omni_js_ctor_nm_[i], (size_t)l) == 0) { ix = i; break; } \
  } \
  if (ix < 0) { \
    omni_errorf("no such builtin constructor: %.*s", (int)name.len, name.p); \
    return omni_dyn_undef(); \
  } \
  if (omni_js_ctor_tbl_[ix].tag == OMNI_DYN_FN) return omni_js_ctor_tbl_[ix]; \
  omni_dyn c = omni_js_nat_(OMNI_JS_CTOR_SEL + ix, omni_dyn_undef()); \
  omni_js_ctor_tbl_[ix] = c; \
  /* prototype 预先坐好（$FNPROTO 的孪生）：不坐的话 fn_proto_ 会现造一格空的， \
     于是 `[] instanceof Array` 静静地变成 false。 */ \
  if (omni_js_fnproto_tbl_ == NULL) omni_js_fnproto_tbl_ = DT##_new(); \
  DT##_set(omni_js_fnproto_tbl_, omni_js_key(c), omni_js_realm_proto(name)); \
  return c; \
} \
/* x.constructor：就是一次普通的属性读（原型链上那一格 constructor）。真对象走槽表与链，
   别的按标签走它那格 realm 原型 —— 那儿的 get 陷阱认得 "constructor"。 */ \
static omni_dyn omni_js_ctor_get(omni_dyn o) { \
  /* omni_js_s16_lit 住在 JSON 段（它排在这一段后头），所以这儿自己造那格名字 */ \
  omni_dyn ck = omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("constructor", 11))); \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_getp(o, ck, o); \
  return omni_js_getp(omni_js_proto_of_tag_(o), ck, o); \
} \
/* globalThis（ADR-0020 P4）：这个值域里没有全局环境记录（模块的顶层名字是模块局部的），
   所以它就是**一格普通的真对象**，每个 realm 一份 —— 与 prelude 里 realm 上那格 gt 逐条
   对应。挂上去的东西读得回来；内建（Math / JSON …）不在它身上，那是画出来的边界，
   不是悄悄给个空对象。 */ \
static omni_dyn omni_js_gt_tbl_[1]; \
static omni_dyn omni_js_global_this(void) { \
  if (omni_js_gt_tbl_[0].tag != OMNI_DYN_OBJ) { \
    omni_js_gt_tbl_[0] = omni_js_new_bare_(omni_js_realm_proto(omni_str_new("Object", 6))); \
  } \
  return omni_js_gt_tbl_[0]; \
} \
/* 一格值的原型（规范里的 [[Prototype]]）。真对象自己带着，别的按标签映到 realm 上 ——
   `[] instanceof Array` 与 `x instanceof Object` 全靠这一格。 */ \
static omni_dyn omni_js_proto_of_tag_(omni_dyn v) { \
  switch (v.tag) { \
    case OMNI_DYN_OBJ: return ((omni_js_objv *)v.u.ref)->pr; \
    case OMNI_DYN_DICT: return omni_js_realm_proto(omni_str_new("Object", 6)); \
    case OMNI_DYN_LIST: return omni_js_realm_proto(omni_str_new("Array", 5)); \
    case OMNI_DYN_STR16: case OMNI_DYN_STRING: \
      return omni_js_realm_proto(omni_str_new("String", 6)); \
    case OMNI_DYN_REAL: return omni_js_realm_proto(omni_str_new("Number", 6)); \
    case OMNI_DYN_BOOL: return omni_js_realm_proto(omni_str_new("Boolean", 7)); \
    case OMNI_DYN_FN: return omni_js_realm_proto(omni_str_new("Function", 8)); \
    case OMNI_DYN_MAP: return omni_js_realm_proto(omni_str_new("Map", 3)); \
    case OMNI_DYN_SET: return omni_js_realm_proto(omni_str_new("Set", 3)); \
    case OMNI_DYN_RE: return omni_js_realm_proto(omni_str_new("RegExp", 6)); \
    case OMNI_DYN_SYM: return omni_js_realm_proto(omni_str_new("Symbol", 6)); \
    default: return omni_dyn_null(); \
  } \
} \
/* 普通函数当构造器（ADR-0020）：`new f(a)` = 造一格以 f.prototype 为原型的对象、拿它当
   接收者跑 f、f 返回对象就用那一格。函数在这个值域里**不是**真对象，所以那格 prototype
   住在一张按同一性索引的旁表上（键就是 omni_js_key 给引用值发的地址）——
   与 prelude 的 $FNPROTO 逐条对应。旁表上那格原型身上挂一格不可枚举的 constructor。 */ \
static omni_dyn omni_js_fn_proto_(omni_dyn f) { \
  if (omni_js_fnproto_tbl_ == NULL) omni_js_fnproto_tbl_ = DT##_new(); \
  omni_str id = omni_js_key(f); \
  int64_t e = DT##_find(omni_js_fnproto_tbl_, id); \
  if (e >= 0) return omni_js_fnproto_tbl_->vals[e]; \
  omni_dyn p = omni_js_obj_new_p(omni_dyn_null()); \
  omni_js_def_data_(p, omni_js_name_("constructor", 11), f, true, false, true); \
  DT##_set(omni_js_fnproto_tbl_, id, p); \
  return p; \
} \
static omni_dyn omni_js_fn_construct(omni_dyn f, omni_dyn args) { \
  /* 右边是一格**类对象**（`new this()` / 局部类：那时候类是一格局部量，降级器发的是这条
     通用路）。类对象不是函数值 —— 构造要走它身上那两格：prototype 当原型、Symbol.omni.classInit
     那格闭包初始化实例。形状与降级器里静态那条路一样，只是类是运行期拿到的。
     与 prelude 的 $js_fn_construct 逐支对齐。 */ \
  if (f.tag == OMNI_DYN_OBJ) { \
    omni_dyn init = omni_js_getp(f, omni_js_sym_wk(omni_str_new("omni.classInit", 14)), \
                                 omni_dyn_undef()); \
    if (init.tag == OMNI_DYN_FN) { \
      omni_dyn o = omni_js_obj_new_p(omni_js_getp(f, omni_js_name_("prototype", 9), \
                                                  omni_dyn_undef())); \
      omni_js_nt_slot_ = f; \
      omni_dyn r0 = omni_js_call_this(init, o, args); \
      omni_js_nt_slot_ = omni_dyn_undef(); \
      if (omni_js_pending()) return omni_dyn_undef(); \
      return omni_js_is_object(r0) ? r0 : o; \
    } \
  } \
  if (f.tag != OMNI_DYN_FN) { \
    if (!omni_js_pending()) omni_js_type_err_c("not a function"); \
    return omni_dyn_undef(); \
  } \
  omni_dyn o = omni_js_obj_new_p(omni_js_fn_proto_(f)); \
  omni_js_nt_slot_ = f; \
  omni_dyn r = omni_js_call_this(f, o, args); \
  omni_js_nt_slot_ = omni_dyn_undef(); \
  if (omni_js_pending()) return omni_dyn_undef(); \
  /* 构造器 return 一格**对象**时值是那一格（规范 10.2.2 第 13 步）：数组、Map、函数都算 */ \
  return omni_js_is_object(r) ? r : o; \
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
  /* 真对象：自有的**可枚举字符串键**（Object.keys 那一档，规范 20.1.2.17） */ \
  if (o.tag == OMNI_DYN_OBJ) return omni_js_obj_own_keys_o_(o, 'e'); \
  DT d = omni_js_dict_of(o); \
  LT out = LT##_new(); \
  LT##_reserve(out, d->count); \
  for (int64_t i = 0; i < d->n; i++) { \
    if (d->live[i]) out->items[out->len++] = omni_dyn_of_s16(omni_s16_of_utf8(d->keys[i])); \
  } \
  return omni_js_arr_wrap(out); \
} \
/* for-in 走一遍的那一串键（ADR-0020 P3）。规范是"自有 + 继承来的可枚举字符串键，去重"。
   容器那几支没有原型链，所以只剩自有那一段；**真对象**这一支要连着原型链走（ADR-0020
   P1-c 的第十步），并且去重 —— 子对象上遮住的名字只报一次。
   容器与真对象之外（数 / 布尔 / null / undefined / 函数值 …）在 JS 里也走不出键来：交空表。
   与 prelude 的 $js_for_in_keys 逐支对齐。 */ \
static omni_dyn omni_js_for_in_keys(omni_dyn o) { \
  if (o.tag == OMNI_DYN_STR16 || o.tag == OMNI_DYN_LIST || o.tag == OMNI_DYN_DICT) { \
    return omni_js_obj_keys(o); \
  } \
  if (o.tag == OMNI_DYN_OBJ) { \
    LT out = LT##_new(); \
    DT seen = DT##_new(); \
    omni_dyn cur = o; \
    while (cur.tag == OMNI_DYN_OBJ) { \
      LT ks = omni_js_arr_of(omni_js_obj_own_keys_o_(cur, 'e')); \
      for (int64_t i = 0; i < ks->len; i++) { \
        omni_str key = omni_js_pkey_(ks->items[i]); \
        if (DT##_contains(seen, key)) continue; \
        DT##_set(seen, key, omni_dyn_of_bool(true)); \
        LT##_push(out, ks->items[i]); \
      } \
      cur = ((omni_js_objv *)cur.u.ref)->pr; \
    } \
    /* 链的末端可能是一格 dict（对象字面量就是 dict）：那一格的键也算继承来的 */ \
    if (omni_js_cont_proto_(cur)) { \
      LT ks = omni_js_arr_of(omni_js_obj_keys(cur)); \
      for (int64_t i = 0; i < ks->len; i++) { \
        omni_str key = omni_js_pkey_(ks->items[i]); \
        if (DT##_contains(seen, key)) continue; \
        DT##_set(seen, key, omni_dyn_of_bool(true)); \
        LT##_push(out, ks->items[i]); \
      } \
    } \
    return omni_js_arr_wrap(out); \
  } \
  return omni_js_arr_wrap(LT##_new()); \
} \
static omni_dyn omni_js_obj_values(omni_dyn o) { \
  /* 真对象：自有可枚举键的值，走 [[Get]]（访问器会被调） */ \
  if (o.tag == OMNI_DYN_OBJ) { \
    LT ks = omni_js_arr_of(omni_js_obj_own_keys_o_(o, 'e')); \
    LT vout = LT##_new(); \
    LT##_reserve(vout, ks->len); \
    for (int64_t i = 0; i < ks->len; i++) { \
      vout->items[vout->len++] = omni_js_getp(o, ks->items[i], omni_dyn_undef()); \
    } \
    return omni_js_arr_wrap(vout); \
  } \
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
  /* 真对象：[键, 值] 两元组，值走 [[Get]] */ \
  if (o.tag == OMNI_DYN_OBJ) { \
    LT ks = omni_js_arr_of(omni_js_obj_own_keys_o_(o, 'e')); \
    LT eout = LT##_new(); \
    LT##_reserve(eout, ks->len); \
    for (int64_t i = 0; i < ks->len; i++) { \
      LT pr = LT##_new(); \
      LT##_reserve(pr, 2); \
      pr->items[0] = ks->items[i]; \
      pr->items[1] = omni_js_getp(o, ks->items[i], omni_dyn_undef()); \
      pr->len = 2; \
      eout->items[eout->len++] = omni_js_arr_wrap(pr); \
    } \
    return omni_js_arr_wrap(eout); \
  } \
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
   undefined / null 当空对象（JS 就是这么规定的），别的原始值一格键都没有、照样空手回。 */ \
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
  /* 别的原始值当源：**什么都不抄**（规范 20.1.2.1 第 4 步 a-ii 是 ToObject 之后走自有可枚举
     键，数 / 布尔 / bigint 包起来一格键都没有）。与 prelude 的 $js_obj_assign 同一条判据 ——
     从前落到 omni_js_dict_of 上、当场报 "dynamic value is real, expected dict"。 */ \
  if (src.tag == OMNI_DYN_BOOL || src.tag == OMNI_DYN_INT || src.tag == OMNI_DYN_REAL \
      || src.tag == OMNI_DYN_UINT) return dst; \
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
  /* 真对象：先走一遍迭代协议摊成 list（ADR-0020 P1-c 的第十一步） */ \
  if (init.tag == OMNI_DYN_OBJ) init = omni_js_iter_o_(init); \
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
  if (init.tag == OMNI_DYN_OBJ) init = omni_js_iter_o_(init); \
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
