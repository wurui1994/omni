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

/* js_wrap_fn 的转接记录（ADR-0013 决策 3）。第一字段是函数指针，所以它就是一条普通的
   闭包记录，宿主库里所有拿 omni_fn 的地方都不知道自己拿的是转接。 */
struct omni_js_wrap_s { omni_fnptr fp; omni_dyn inner; };

/* omni_js_call：JS 的函数在 Omni 里只有一个签名 fn(list<dynamic>) -> dynamic
   （ADR-0011 第 1 节），所以回调不需要按签名分派，装好实参表直接调。
   omni_js_call3 是 map/filter/forEach 那批的固定三实参形式（值、下标、数组本身）。 */
#define OMNI_JS_ARR(LT, DT) \
static omni_dyn omni_js_call(omni_dyn f, LT args) { \
  omni_fn fp = omni_js_as_fn(f); \
  return ((omni_dyn (*)(omni_fn, LT))omni_fn_ck(fp)->fp)(fp, args); \
} \
/* 按名字调 op 的那条路（js_call_fn，ADR-0013）：实参已经是一条 list。解释器造出来的
   函数值在这一代里就是一条闭包记录，所以这里没有任何胶水，就是上面那次普通 C 调用。 */ \
static omni_dyn omni_js_call_fn(omni_dyn f, omni_dyn args) { \
  return omni_js_call(f, (LT)omni_dyn_as_ref(args, OMNI_DYN_LIST)); \
} \
/* this 怎么传（ADR-0020 P1）：函数签名是 fn(list<dynamic>) -> dynamic，**没有 this 槽**， \
   而改签名要动闭包记录、MakeClosure 与两个后端的调用约定。所以接收者走一格运行期的槽 —— \
   调用前放进去，被调函数入口的 js_this_take 取走并清空。规矩两条（与 prelude 逐字对齐）： \
     1. 只有 js_call_this 会往槽里放东西，而且**返回之后一律清成 undefined**； \
     2. 取的人是函数入口，读一次就清。 \
   于是"没有接收者的那些调用"看到的一定是 undefined，不管上一趟留下过什么。 */ \
static omni_dyn omni_js_this_slot_ = { OMNI_DYN_UNDEF, { 0 } }; \
static omni_dyn omni_js_this_take(void) { \
  omni_dyn v = omni_js_this_slot_; \
  omni_js_this_slot_ = omni_dyn_undef(); \
  return v; \
} \
static omni_dyn omni_js_call_this(omni_dyn f, omni_dyn thisv, omni_dyn args) { \
  omni_js_this_slot_ = thisv; \
  omni_dyn r = omni_js_call(f, (LT)omni_dyn_as_ref(args, OMNI_DYN_LIST)); \
  omni_js_this_slot_ = omni_dyn_undef(); \
  return r; \
} \
OMNI_JS_ARR_WRAP(LT, DT) \
static omni_dyn omni_js_call3(omni_dyn f, omni_dyn a, int64_t i, omni_dyn self) { \
  /* 精确三格，不走 reserve（那按最小 4 分配，1/4 是白扔的，而 arena 不回收）： \
     这是整个运行时最热的分配点 —— 量过，编译整个编译器有 127 万次回调从这里过。 */ \
  const omni_dyn tmp[3] = { a, omni_dyn_of_real((double)i), self }; \
  return omni_js_call(f, LT##_from(tmp, 3)); \
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
/* 带接收者的那一份（ADR-0020 P1）：`o.m(x)` 落到兜底上时 this **就是 o** —— \
   原型上的方法与类的方法全靠这一格。与 prelude 的 $js_call_n_this 逐字对应。 */ \
static omni_dyn omni_js_call_n_this(omni_dyn f, omni_dyn recv, int64_t n, const omni_dyn *a) { \
  while (n > 0 && a[n - 1].tag == OMNI_DYN_UNDEF) n--; \
  LT args = LT##_new(); \
  if (n > 0) { \
    LT##_reserve(args, n); \
    for (int64_t i = 0; i < n; i++) args->items[i] = a[i]; \
    args->len = n; \
  } \
  omni_js_this_slot_ = recv; \
  omni_dyn r = omni_js_call(f, args); \
  omni_js_this_slot_ = omni_dyn_undef(); \
  return r; \
} \
static LT omni_js_arr_of(omni_dyn v) { return (LT)omni_dyn_as_ref(v, OMNI_DYN_LIST); } \
static omni_dyn omni_js_arr_wrap(LT l) { return omni_dyn_of_ref((void *)l, OMNI_DYN_LIST); } \
static omni_dyn omni_js_arr_new(void) { return omni_js_arr_wrap(LT##_new()); } \
static omni_dyn omni_js_arr_new_n(omni_dyn n) { \
  LT l = LT##_new(); \
  int64_t len, k; \
  if (n.tag != OMNI_DYN_REAL) { \
    LT##_push(l, n); \
    return omni_js_arr_wrap(l); \
  } \
  if (!(n.u.r >= 0 && n.u.r <= 4294967295.0 && n.u.r == floor(n.u.r))) { \
    omni_error("invalid array length"); \
  } \
  len = (int64_t)n.u.r; \
  LT##_reserve(l, len); \
  for (k = 0; k < len; k++) l->items[k] = omni_dyn_undef(); \
  l->len = len; \
  return omni_js_arr_wrap(l); \
} \
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
/* 下标是编译期常量时走这条：省掉把它装成 omni_dyn 再过一遍 NaN/范围检查。
   JS 域的实参表就是一条 list，`v_x = arr_get(args, 0)` 是每次调用都要走的一步。 */ \
static omni_dyn omni_js_arr_geti(omni_dyn a, int64_t k) { \
  LT l = omni_js_arr_of(a); \
  return (k < 0 || k >= l->len) ? omni_dyn_undef() : l->items[k]; \
} \
static omni_dyn omni_js_arr_get(omni_dyn a, omni_dyn i) { \
  return omni_js_arr_geti(a, omni_js_arr_i(i)); \
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
/* a.unshift(x)：往头上插一格，回新长度。先 push 占一格（顺带把容量扩够），
   再从后往前挪一位。O(n) —— JS 那边也是。 */ \
static omni_dyn omni_js_arr_unshift(omni_dyn a, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  LT##_push(l, v); \
  for (int64_t i = l->len - 1; i > 0; i--) l->items[i] = l->items[i - 1]; \
  l->items[0] = v; \
  return omni_dyn_of_real((double)l->len); \
} \
/* shift：摘掉头一格并交出来（空数组给 undefined）。判据与 prelude 的 $js_arr_shift 相同。 */ \
static omni_dyn omni_js_arr_shift(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  if (l->len == 0) return omni_dyn_undef(); \
  omni_dyn head = l->items[0]; \
  for (int64_t i = 1; i < l->len; i++) l->items[i - 1] = l->items[i]; \
  l->len--; \
  return head; \
} \
OMNI_JS_ARR_2(LT, DT)

/* js_wrap_fn（ADR-0013 决策 3）：解释器造函数值走这一条。传进来的 f 是解释器自己那个
   两形参的 lambda，降级后它的实参是**一条表**（JS 域的唯一签名），所以这里造一条转接
   记录：宿主按 fp(self, args) 调这个值，转接把 (self, args) 装成那条表再调 f。
   恒等是不行的 —— 那样 f 会把 args[0] 当 self、args[1] 当实参表。
   转接自己也是一条闭包记录，所以在 C 侧和 AOT 编出来的函数不可区分。 */
#define OMNI_JS_ARR_WRAP(LT, DT) \
static omni_dyn omni_js_wrap_call_(omni_fn me, LT args) { \
  const omni_dyn tmp[2] = { \
    omni_dyn_of_fn(me), \
    omni_dyn_of_ref((void *)args, OMNI_DYN_LIST), \
  }; \
  return omni_js_call(((struct omni_js_wrap_s *)me)->inner, LT##_from(tmp, 2)); \
} \
static omni_dyn omni_js_wrap_fn(omni_dyn f) { \
  struct omni_js_wrap_s *w = (struct omni_js_wrap_s *)omni_alloc(sizeof *w); \
  w->fp = (omni_fnptr)omni_js_wrap_call_; \
  w->inner = f; \
  return omni_dyn_of_fn((omni_fn)w); \
}

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
static omni_dyn omni_js_arr_at(omni_dyn a, omni_dyn i) { \
  LT l = omni_js_arr_of(a); \
  int64_t k = omni_js_arr_i(i); \
  if (k < 0) k += l->len; \
  if (k < 0 || k >= l->len) return omni_dyn_undef(); \
  return l->items[k]; \
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
  /* 实参**不是数组**时当一格元素追上去（规范 23.1.3.1 的 IsConcatSpreadable）：
     [1].concat([2], 3) 是 [1,2,3]。判据与 prelude 的 $js_arr_concat 相同。 */ \
  LT x = omni_js_arr_of(a); \
  if (b.tag != OMNI_DYN_LIST) { \
    LT one = LT##_new(); \
    LT##_reserve(one, x->len + 1); \
    for (int64_t i = 0; i < x->len; i++) one->items[one->len++] = x->items[i]; \
    one->items[one->len++] = b; \
    return omni_js_arr_wrap(one); \
  } \
  LT y = omni_js_arr_of(b); \
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
static omni_dyn omni_js_arr_fill(omni_dyn a, omni_dyn v, omni_dyn s, omni_dyn e) { \
  LT l = omni_js_arr_of(a); \
  int64_t start = omni_js_arr_rel(s.tag == OMNI_DYN_UNDEF ? 0 : omni_js_arr_i(s), l->len); \
  int64_t end = omni_js_arr_rel(e.tag == OMNI_DYN_UNDEF ? l->len : omni_js_arr_i(e), l->len); \
  for (int64_t i = start; i < end; i++) l->items[i] = v; \
  return a; \
} \
/* copyWithin：同一格数组里把 [s, e) 挪到 t 起。区间会重叠，所以**先拷一份再写** \
   （规范 23.1.3.4 按方向选挪的向，这一份等价而更直白）。 */ \
static omni_dyn omni_js_arr_copy_within(omni_dyn a, omni_dyn t, omni_dyn s, omni_dyn e) { \
  LT l = omni_js_arr_of(a); \
  int64_t to = omni_js_arr_rel(t.tag == OMNI_DYN_UNDEF ? 0 : omni_js_arr_i(t), l->len); \
  int64_t start = omni_js_arr_rel(s.tag == OMNI_DYN_UNDEF ? 0 : omni_js_arr_i(s), l->len); \
  int64_t end = omni_js_arr_rel(e.tag == OMNI_DYN_UNDEF ? l->len : omni_js_arr_i(e), l->len); \
  int64_t n = end - start; \
  if (n > l->len - to) n = l->len - to; \
  if (n <= 0) return a; \
  LT tmp = LT##_new(); \
  LT##_reserve(tmp, n); \
  for (int64_t i = 0; i < n; i++) tmp->items[tmp->len++] = l->items[start + i]; \
  for (int64_t i = 0; i < n; i++) l->items[to + i] = tmp->items[i]; \
  return a; \
} \
static bool omni_js_arr_is_array(omni_dyn v) { return v.tag == OMNI_DYN_LIST; } \
/* Array.from(v[, f]) 不在这一段里 —— 它要读类数组的 length（omni_js_obj_get），而那一族
   在 omni_js_obj.h 里、比这一段**后**展开。所以它定义在那边（同名同形）。 */ \
/* 第三格是 fromIndex（规范 23.1.3.17 / .21 / .16）：负数从末尾数，越界就夹住 */ \
static int64_t omni_js_arr_from_idx(int64_t len, omni_dyn from, int64_t dflt) { \
  if (from.tag == OMNI_DYN_UNDEF) return dflt; \
  int64_t i = omni_js_arr_i(from); \
  return i < 0 ? len + i : i; \
} \
static omni_dyn omni_js_arr_index_of(omni_dyn a, omni_dyn v, omni_dyn from) { \
  LT l = omni_js_arr_of(a); \
  int64_t i = omni_js_arr_from_idx(l->len, from, 0); \
  if (i < 0) i = 0; \
  for (; i < l->len; i++) { \
    if (omni_js_eq(true, l->items[i], v)) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
static omni_dyn omni_js_arr_last_index_of(omni_dyn a, omni_dyn v, omni_dyn from) { \
  LT l = omni_js_arr_of(a); \
  int64_t i = omni_js_arr_from_idx(l->len, from, l->len - 1); \
  if (i >= l->len) i = l->len - 1; \
  for (; i >= 0; i--) { \
    if (omni_js_eq(true, l->items[i], v)) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
static bool omni_js_arr_includes(omni_dyn a, omni_dyn v, omni_dyn from) { \
  LT l = omni_js_arr_of(a); \
  bool nan = v.tag == OMNI_DYN_REAL && isnan(v.u.r); \
  int64_t i = omni_js_arr_from_idx(l->len, from, 0); \
  if (i < 0) i = 0; \
  for (; i < l->len; i++) { \
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
  /* 分隔符照规范 ToString（22.1.3.18 第 4 步）：缺席才是 ","，null 是 "null" 而不是报错 */ \
  omni_s16 s = sep.tag == OMNI_DYN_UNDEF \
    ? omni_s16_of_utf8(omni_str_new(",", 1)) : omni_js_as_s16(omni_js_str(sep)); \
  omni_s16 out = omni_s16_of_utf8(omni_str_new("", 0)); \
  for (int64_t i = 0; i < l->len; i++) { \
    if (i) out = omni_s16_cat(out, s); \
    omni_dyn x = l->items[i]; \
    if (x.tag == OMNI_DYN_NULL || x.tag == OMNI_DYN_UNDEF) continue; \
    out = omni_s16_cat(out, omni_js_as_s16(omni_js_str(x))); \
  } \
  return omni_dyn_of_s16(out); \
} \
/* 回调里 throw 了要**立刻停**：这个值域里 throw 是"放一格 pending 再跳"（ADR-0007 决定 1），
   所以每调一次回调之后都要问一句 omni_js_pending()。不问就是静默多跑几圈 —— 量出来的
   [1,2,3].forEach(x => { seen.push(x); if (x === 2) throw … }) 在 node 上 seen 是 1,2。
   与 prelude 的 $js_arr_* 逐行对着写；抛了之后返回值没人看，给个形状对的就行。 */ \
static omni_dyn omni_js_arr_map(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) { \
    out->items[out->len++] = omni_js_call3(f, l->items[i], i, a); \
    if (omni_js_pending()) break; \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_filter(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  for (int64_t i = 0; i < l->len; i++) { \
    bool keep = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) break; \
    if (keep) LT##_push(out, l->items[i]); \
  } \
  return omni_js_arr_wrap(out); \
} \
static void omni_js_arr_for_each(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    omni_js_call3(f, l->items[i], i, a); \
    if (omni_js_pending()) return; \
  } \
} \
static bool omni_js_arr_some(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    bool hit = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) return false; \
    if (hit) return true; \
  } \
  return false; \
} \
static bool omni_js_arr_every(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    bool ok = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) return false; \
    if (!ok) return false; \
  } \
  return true; \
} \
static omni_dyn omni_js_arr_find(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    bool hit = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) return omni_dyn_undef(); \
    if (hit) return l->items[i]; \
  } \
  return omni_dyn_undef(); \
} \
static omni_dyn omni_js_arr_find_index(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = 0; i < l->len; i++) { \
    bool hit = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) return omni_dyn_of_real(-1.0); \
    if (hit) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
static omni_dyn omni_js_arr_find_last(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = l->len - 1; i >= 0; i--) { \
    bool hit = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) return omni_dyn_undef(); \
    if (hit) return l->items[i]; \
  } \
  return omni_dyn_undef(); \
} \
static omni_dyn omni_js_arr_find_last_index(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  for (int64_t i = l->len - 1; i >= 0; i--) { \
    bool hit = omni_js_truthy(omni_js_call3(f, l->items[i], i, a)); \
    if (omni_js_pending()) return omni_dyn_of_real(-1.0); \
    if (hit) return omni_dyn_of_real((double)i); \
  } \
  return omni_dyn_of_real(-1.0); \
} \
OMNI_JS_ARR_4(LT, DT)

/* 第四段：reduce / reduceRight / flat / flatMap / sort / toSorted。
   sort 用自底向上的归并 —— 稳定，而且不递归。比较器返回 Number，只看符号；
   返回 NaN 当作 0（JS 里是"未指定"，但两个后端必须选同一种未指定行为）。
   toSorted 是"整段拷贝 + 就地排"，于是稳定性与比较器语义完全跟着 sort 那一份。
   flat 一层一层摊，不递归：深度只是个计数，某一层里没有数组了就提前收工，
   所以 Infinity 也收得下，而且深数组不会把 C 栈捅穿。 */
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
    if (omni_js_pending()) return omni_dyn_undef(); \
  } \
  return acc; \
} \
static omni_dyn omni_js_arr_reduce_right(omni_dyn a, omni_dyn f, omni_dyn init) { \
  LT l = omni_js_arr_of(a); \
  int64_t i = l->len - 1; \
  omni_dyn acc; \
  if (init.tag == OMNI_DYN_UNDEF) { \
    if (l->len == 0) omni_error("reduce of empty array with no initial value"); \
    acc = l->items[i]; i--; \
  } else { \
    acc = init; \
  } \
  for (; i >= 0; i--) { \
    LT args = LT##_new(); \
    LT##_reserve(args, 4); \
    args->items[0] = acc; \
    args->items[1] = l->items[i]; \
    args->items[2] = omni_dyn_of_real((double)i); \
    args->items[3] = a; \
    args->len = 4; \
    acc = omni_js_call(f, args); \
    if (omni_js_pending()) return omni_dyn_undef(); \
  } \
  return acc; \
} \
static omni_dyn omni_js_arr_flat(omni_dyn a, omni_dyn d) { \
  LT src = omni_js_arr_of(a); \
  int64_t depth = d.tag == OMNI_DYN_UNDEF ? 1 : omni_js_arr_i(d); \
  LT out = LT##_new(); \
  LT##_reserve(out, src->len); \
  for (int64_t i = 0; i < src->len; i++) out->items[i] = src->items[i]; \
  out->len = src->len; \
  for (int64_t k = 0; k < depth; k++) { \
    bool nested = false; \
    LT next = LT##_new(); \
    for (int64_t i = 0; i < out->len; i++) { \
      omni_dyn x = out->items[i]; \
      if (x.tag == OMNI_DYN_LIST) { \
        LT s = (LT)x.u.ref; \
        nested = true; \
        for (int64_t j = 0; j < s->len; j++) LT##_push(next, s->items[j]); \
      } else { \
        LT##_push(next, x); \
      } \
    } \
    out = next; \
    if (!nested) break; \
  } \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_flat_map(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  for (int64_t i = 0; i < l->len; i++) { \
    omni_dyn r = omni_js_call3(f, l->items[i], i, a); \
    if (omni_js_pending()) break; \
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
static omni_dyn omni_js_arr_to_sorted(omni_dyn a, omni_dyn f) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) out->items[i] = l->items[i]; \
  out->len = l->len; \
  return omni_js_arr_sort(omni_js_arr_wrap(out), f); \
} \
/* toReversed / with：同一族的另外两格 —— 拷一份再改，原数组不动。
   with 的下标认负数；越界在规范里是 RangeError，这个值域里当场报错。 */ \
static omni_dyn omni_js_arr_to_reversed(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) out->items[i] = l->items[l->len - 1 - i]; \
  out->len = l->len; \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_with(omni_dyn a, omni_dyn i, omni_dyn v) { \
  LT l = omni_js_arr_of(a); \
  int64_t k = omni_js_arr_i(i); \
  if (k < 0) k += l->len; \
  if (k < 0 || k >= l->len) omni_error("index out of range in with()"); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t j = 0; j < l->len; j++) out->items[j] = l->items[j]; \
  out->len = l->len; \
  out->items[k] = v; \
  return omni_js_arr_wrap(out); \
} \
/* splice / toSpliced：第二格是**整串实参**摊成的一格 list —— 实参个数是语义的一部分
   （splice(1) 删到底、splice(1, undefined) 一格都不删），定长的形参表达不了。
   与 prelude 的 $js_arr_splice 同一套夹取：起点认负数、删数夹到 [0, len-start]。
   splice 就地改（items/len/cap 整格换掉），toSpliced 交一份新的出去。 */ \
static omni_dyn omni_js_arr_splice_(omni_dyn a, omni_dyn argsv, bool copy) { \
  LT l = omni_js_arr_of(a); \
  LT args = omni_js_arr_of(argsv); \
  int64_t len = l->len; \
  int64_t start = 0; \
  if (args->len > 0) { \
    int64_t rel = omni_js_arr_i(args->items[0]); \
    if (rel < 0) start = len + rel > 0 ? len + rel : 0; \
    else start = rel < len ? rel : len; \
  } \
  int64_t dc; \
  if (args->len == 0) dc = 0; \
  else if (args->len == 1) dc = len - start; \
  else { \
    dc = omni_js_arr_i(args->items[1]); \
    if (dc < 0) dc = 0; \
    if (dc > len - start) dc = len - start; \
  } \
  int64_t ins = args->len > 2 ? args->len - 2 : 0; \
  LT rem = LT##_new(); \
  LT##_reserve(rem, dc); \
  for (int64_t i = 0; i < dc; i++) rem->items[i] = l->items[start + i]; \
  rem->len = dc; \
  LT out = LT##_new(); \
  LT##_reserve(out, len - dc + ins); \
  int64_t k = 0; \
  for (int64_t i = 0; i < start; i++) out->items[k++] = l->items[i]; \
  for (int64_t i = 0; i < ins; i++) out->items[k++] = args->items[2 + i]; \
  for (int64_t i = start + dc; i < len; i++) out->items[k++] = l->items[i]; \
  out->len = k; \
  if (copy) return omni_js_arr_wrap(out); \
  l->items = out->items; \
  l->len = out->len; \
  l->cap = out->cap; \
  return omni_js_arr_wrap(rem); \
} \
static omni_dyn omni_js_arr_splice(omni_dyn a, omni_dyn args) { \
  return omni_js_arr_splice_(a, args, false); \
} \
static omni_dyn omni_js_arr_to_spliced(omni_dyn a, omni_dyn args) { \
  return omni_js_arr_splice_(a, args, true); \
} \
/* keys / values（数组那一支）：迭代器在这个值域里就是一格 list，与 entries 同一个口径 */ \
static omni_dyn omni_js_arr_keys(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) out->items[i] = omni_dyn_of_real((double)i); \
  out->len = l->len; \
  return omni_js_arr_wrap(out); \
} \
static omni_dyn omni_js_arr_values(omni_dyn a) { \
  LT l = omni_js_arr_of(a); \
  LT out = LT##_new(); \
  LT##_reserve(out, l->len); \
  for (int64_t i = 0; i < l->len; i++) out->items[i] = l->items[i]; \
  out->len = l->len; \
  return omni_js_arr_wrap(out); \
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
