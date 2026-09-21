/* JS 前端的运算语义（ADR-0011 第 4 节）
 *
 * 这个文件里的每一条规则都必须和 backend-js/prelude.js 里的 $js_* 逐位对应。
 * 判据不是"看起来像 JS"，而是 tests/oracle 里拿 node 当参照跑出来一样。
 *
 * 刻意**不**实现 ToPrimitive：对象/数组参与算术在编译器源码里是 bug，不是特性。
 * 与其两个后端各自模仿一套 `[object Object]` 规则，不如当场报错。
 */
#include "omni.h"

/* ---------------------------------------------------------------- 真假 */

bool omni_js_truthy(omni_dyn v) {
  switch (v.tag) {
    case OMNI_DYN_UNDEF: case OMNI_DYN_NULL: return false;
    case OMNI_DYN_BOOL: return v.u.b;
    case OMNI_DYN_INT: case OMNI_DYN_UINT: return v.u.i != 0;
    /* NaN 与 ±0 都是假 */
    case OMNI_DYN_REAL: return !(v.u.r == 0.0 || isnan(v.u.r));
    case OMNI_DYN_STR16: return v.u.s16.len != 0;
    default: return true;  /* 对象、数组、函数一律真 */
  }
}

omni_dyn omni_js_typeof(omni_dyn v) {
  const char *n;
  switch (v.tag) {
    case OMNI_DYN_UNDEF: n = "undefined"; break;
    case OMNI_DYN_NULL: n = "object"; break;
    case OMNI_DYN_BOOL: n = "boolean"; break;
    /* int 是 BigInt 的映像（ADR-0011 第 5 节），所以 typeof 是 bigint。
       UINT 在 JS 那边也就是个 BigInt，同一支。 */
    case OMNI_DYN_INT: case OMNI_DYN_UINT: n = "bigint"; break;
    case OMNI_DYN_REAL: n = "number"; break;
    case OMNI_DYN_STR16: n = "string"; break;
    case OMNI_DYN_FN: n = "function"; break;
    case OMNI_DYN_SYM: n = "symbol"; break;
    default: n = "object"; break;
  }
  /* 常量串不必过一遍 snprintf：of_utf8 那张 intern 表会把它认出来（omni_str16.c）。
     量出来的：printf 那一族约 625 个样本，其中 485 落在 omni_js_typeof 这一条上。 */
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(n, (int64_t)strlen(n))));
}

/* dynamic 的运行期标签名（JS 域口径）。解释器靠它认出一个 dynamic 里装的是什么
   （ADR-0013）：`instanceof Map` 不在语言子集里，而 C 侧本来就有标签。
   名字必须与 host/native.js 的 typeTag 和 prelude 的 $js_type_tag 逐字一致 ——
   它们会进错误消息。JS 域的 Map/Set 与 Omni 的 dict/set 在这里是**不同**的标签。 */
omni_dyn omni_js_type_tag(omni_dyn v) {
  const char *n;
  switch (v.tag) {
    case OMNI_DYN_UNDEF: n = "undefined"; break;
    case OMNI_DYN_NULL: n = "null"; break;
    case OMNI_DYN_BOOL: n = "bool"; break;
    case OMNI_DYN_INT: case OMNI_DYN_UINT: n = "int"; break;
    case OMNI_DYN_REAL: n = "real"; break;
    case OMNI_DYN_STRING: case OMNI_DYN_STR16: n = "string"; break;
    case OMNI_DYN_LIST: n = "list"; break;
    case OMNI_DYN_DICT: n = "dict"; break;
    case OMNI_DYN_MAP: n = "Map"; break;
    case OMNI_DYN_SET: n = "Set"; break;
    case OMNI_DYN_RE: n = "regexp"; break;
    case OMNI_DYN_BYTES: n = "bytes"; break;
    case OMNI_DYN_TEXTENC: n = "TextEncoder"; break;
    case OMNI_DYN_TEXTDEC: n = "TextDecoder"; break;
    case OMNI_DYN_SYM: n = "symbol"; break;
    /* 真对象（ADR-0020 P1-c）：解释器的成员派发靠这个名字认接收者，与 prelude 的
       $js_type_tag 对 $JSObj 给的 "object" 逐字一致 —— 默认那一支是 "function"，
       落进去就会把对象当函数值派发。 */
    case OMNI_DYN_OBJ: n = "object"; break;
    default: n = "function"; break;
  }
  /* 常量串不必过一遍 snprintf：of_utf8 那张 intern 表会把它认出来（omni_str16.c）。
     量出来的：printf 那一族约 625 个样本，其中 485 落在 omni_js_typeof 这一条上。 */
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(n, (int64_t)strlen(n))));
}

/* real 的两种文本化，给解释器用（ADR-0013）。刻意就是 print / repr 自己用的那两个
   函数：解释器不写第三份浮点格式化，于是解释执行与编译执行打印出同一串字符，
   是构造性的，而不是三份代码碰巧一致。 */
static double want_fmt_num(omni_dyn v, const char *who) {
  if (v.tag == OMNI_DYN_REAL) return v.u.r;
  if (v.tag == OMNI_DYN_INT) return (double)v.u.i;
  if (v.tag == OMNI_DYN_UINT) return (double)omni_dyn_u64(v);
  omni_errorf("%s expects a number, found %s", who, omni_dyn_tag_name(v.tag));
  return 0.0;
}

omni_dyn omni_js_fmt_real(omni_dyn v) {
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_real(want_fmt_num(v, "fmtReal"))));
}

/* 按 N 位有效数字。解释器上的 `(tostr E N)` 走这一条，于是它与两个后端印出的是同一串
   字符（用的就是后端自己那份 omni_str_realg）。 */
omni_dyn omni_js_fmt_real_g(omni_dyn v, omni_dyn p) {
  double x = want_fmt_num(v, "fmtRealG");
  int64_t n = (int64_t)want_fmt_num(p, "fmtRealG");
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_realg(x, n)));
}

omni_dyn omni_js_repr_real(omni_dyn v) {
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_repr_real(want_fmt_num(v, "reprReal"))));
}

/* `%f` / `%e` / `%g` 那三种排版：解释器上 `(sfix …)` / `(ssci …)` / `(sgen …)` 走这三条。
   与 fmtReal 同一条纪律 —— 用的就是这条腿自己那几份（omni_str_fixed / _sci / _gen / _genk），
   所以解释执行与编译执行印出同一串字符是构造性的。 */
omni_dyn omni_js_fmt_fixed(omni_dyn v, omni_dyn p) {
  double x = want_fmt_num(v, "fmtFixed");
  int64_t n = (int64_t)want_fmt_num(p, "fmtFixed");
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fixed(x, n)));
}

omni_dyn omni_js_fmt_sci(omni_dyn v, omni_dyn p) {
  double x = want_fmt_num(v, "fmtSci");
  int64_t n = (int64_t)want_fmt_num(p, "fmtSci");
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_sci(x, n)));
}

omni_dyn omni_js_fmt_gen(omni_dyn v, omni_dyn p, omni_dyn keep) {
  double x = want_fmt_num(v, "fmtGen");
  int64_t n = (int64_t)want_fmt_num(p, "fmtGen");
  omni_str s = omni_dyn_as_bool(keep) ? omni_str_genk(x, n) : omni_str_gen(x, n);
  return omni_dyn_of_s16(omni_s16_of_utf8(s));
}

/* ---------------------------------------------------------------- 文本化 */

/* JS 的 Number -> String（ECMA-262 Number::toString）。
 *
 * 刻意**不**复用 omni_repr_real：那个是 Omni 自己的约定，整数值会补 ".0"，
 * 而且指数形式走 %g（"1e-07"，两位指数），JS 是 "1e-7"。差一个字符，自举就不收敛。
 *
 * 算法照抄规范：把 v 写成 s x 10^(n-k)，s 是 k 位十进制数字（最短往返、无尾零），
 * 然后按 n 与 k 的关系分五种排布。 */
static omni_str js_num_str(double v) {
  if (isnan(v)) return omni_str_new("NaN", 3);
  if (isinf(v)) return v > 0 ? omni_str_new("Infinity", 8) : omni_str_new("-Infinity", 9);
  if (v == 0.0) return omni_str_new("0", 1);

  /* 整数的快路。**量出来的**：native 那一趟 GLR 建表（12.2s，node 只要 2.4s）里三分之一
     的时间落在 `__dtoa` / `__vfprintf` / `strtod` / `localeconv_l` 上 —— 全是下面那个
     "最短往返"循环：每印一个数要 2~17 次 snprintf 加同样多次 strtod，而建表时印的几乎
     全是**小整数**（状态号、规则号、点的位置 —— `${a},${b}` 那种键）。
     `/usr/bin/sample` 的榜首就是这几个：__dtoa 662、__vfprintf 649、to_s16 308。

     为什么这条快路给出的字符与下面那一支**逐字节相同**：
       - |v| < 2^53 的整数，那一段里相邻两个 double 的间距 <= 1，所以更短的十进制串会落到
         另一个数上 —— 它自己的数字串就是"最短往返"的那一串；
       - JS 对这种数印的正是那串数字（ECMA-262 Number::toString 里 `k <= n && n <= 21`
         那一支，也就是下面第一个分支），没有小数点、没有指数。
     所以这是一条**纯粹的加速**，不是另一套排版。-0 到不了这儿（上面那句 `v == 0.0`
     先接了，印 "0"，与 JS 同）。 */
  if (v == floor(v) && v > -9007199254740992.0 && v < 9007199254740992.0) {
    char tmp[24];
    int64_t iv = (int64_t)v;
    bool ineg = iv < 0;
    uint64_t u = ineg ? (uint64_t)(-(iv + 1)) + 1u : (uint64_t)iv;
    int t = 0;
    do { tmp[t++] = (char)('0' + (int)(u % 10u)); u /= 10u; } while (u != 0u);
    int64_t len = (int64_t)t + (ineg ? 1 : 0);
    char *out = omni_alloc_bytes(len + 1);
    char *o = out;
    if (ineg) *o++ = '-';
    while (t > 0) *o++ = tmp[--t];
    *o = '\0';
    return omni_str_new(out, len);
  }

  bool neg = v < 0;
  double a = neg ? -v : v;

  /* 最短往返：%.*e 给出 d.ddd...e±XX，从 1 位有效数字开始试 */
  char buf[64];
  for (int k = 1; k <= 17; k++) {
    snprintf(buf, sizeof buf, "%.*e", k - 1, a);
    if (strtod(buf, NULL) == a) break;
  }

  /* 拆出数字串与十进制指数 */
  char digits[24];
  int k = 0;
  const char *p = buf;
  for (; *p && *p != 'e' && *p != 'E'; p++) {
    if (*p >= '0' && *p <= '9') digits[k++] = *p;
  }
  int n = (*p ? atoi(p + 1) : 0) + 1;   /* v = 0.digits x 10^n */
  while (k > 1 && digits[k - 1] == '0') k--;   /* 去尾零，n 不变 */
  digits[k] = '\0';

  char out[64];
  char *o = out;
  if (neg) *o++ = '-';
  if (k <= n && n <= 21) {
    memcpy(o, digits, (size_t)k); o += k;
    for (int i = 0; i < n - k; i++) *o++ = '0';
  } else if (0 < n && n <= 21) {
    memcpy(o, digits, (size_t)n); o += n;
    *o++ = '.';
    memcpy(o, digits + n, (size_t)(k - n)); o += k - n;
  } else if (-6 < n && n <= 0) {
    *o++ = '0'; *o++ = '.';
    for (int i = 0; i < -n; i++) *o++ = '0';
    memcpy(o, digits, (size_t)k); o += k;
  } else {
    *o++ = digits[0];
    if (k > 1) {
      *o++ = '.';
      memcpy(o, digits + 1, (size_t)(k - 1)); o += k - 1;
    }
    *o++ = 'e';
    *o++ = n - 1 >= 0 ? '+' : '-';
    int e = n - 1 >= 0 ? n - 1 : -(n - 1);
    o += snprintf(o, 8, "%d", e);
  }
  *o = '\0';
  /* out 是栈上的；omni_str_new 只存指针不拷贝，所以必须让 omni_str_fmt 把它搬到 arena */
  return omni_str_fmt("%s", out);
}

/* 整数直接写成 s16 —— **不走 UTF-8 那一趟**（十进制数字全是 ASCII，一个码位一格）。
   量出来的：`String(i)` 那一格 300k 次要 65ms，node 只要 4ms（**16 倍**），而它的钱花在
   "先排成 UTF-8、再 of_utf8 转 s16"这一来一回上（一次 arena 分配 + 一次哈希 + 一次 alloc16）。
   omni_s16_of_units 自己会拷一份（omni_str16.c:57-61），所以这儿的栈缓冲是安全的。
   代价说清：这条路**绕过了 of_utf8 那张 intern 表**，所以同一个数字反复转会各分配一份；
   而拼键这个值域里数字几乎都不重复（规则号、状态号），量出来是净赚。 */
static omni_s16 js_i64_s16(int64_t iv) {
  uint16_t tmp[24];
  uint16_t out[24];
  int t = 0;
  bool neg = iv < 0;
  uint64_t u = neg ? (uint64_t)(-(iv + 1)) + 1u : (uint64_t)iv;
  do { tmp[t++] = (uint16_t)('0' + (int)(u % 10u)); u /= 10u; } while (u != 0u);
  int k = 0;
  if (neg) out[k++] = (uint16_t)'-';
  while (t > 0) out[k++] = tmp[--t];
  return omni_s16_of_units(out, k);
}

/* dict 里按名字取一格（只读、线性扫）。错误对象只有三四格，String() 这条路也不热，
   所以不去碰模板的哈希索引 —— 那要连 idx / 探测链一起复述，代价与收益不成比例。 */
static const omni_dyn *js_dict_find(const omni_js_dict_view *d, const char *name) {
  int64_t n = (int64_t)strlen(name);
  for (int64_t i = 0; i < d->n; i++) {
    if (!d->live[i]) continue;
    if (d->keys[i].len == n && memcmp(d->keys[i].p, name, (size_t)n) == 0) return &d->vals[i];
  }
  return NULL;
}

/* 自引用的数组：`const a = [1]; a.push(a); String(a)` 在两把尺子上都是**栈溢出**
   （qjs 报 InternalError: stack overflow）。宿主崩是最坏的一档，所以这儿自己拦一道 ——
   深到这个数就当场报，说清是哪种情况。 */
#define OMNI_JS_S16_MAX_DEPTH 128
static int js_s16_depth = 0;

/* 真对象上有没有一格自己的 toString（ADR-0020 P1-c）。有就得**调**它，而调回调要现拼一条
   实参 list —— list 的具体类型只在生成的那个翻译单元里，这儿造不出来。所以这儿只负责
   "看一眼"，看见了让调用点当场报，不给 "[object Object]"（那是悄悄的错答案）。
   槽表的键是 omni_js_pkey_ 发的：一个 's' 标签字节 + UTF-8 的名字，所以 "toString" 是
   9 个字节的 "stoString"。 */
/* 一格真对象**自有**槽里的 toString：找到给出那格的槽（没有给 NULL）。 */
static const omni_js_list_view *js_obj_own_ts_slot_(omni_dyn o) {
  const omni_js_objv *ov = (const omni_js_objv *)o.u.ref;
  const omni_js_dict_view *ps = (const omni_js_dict_view *)ov->ps;
  for (int64_t i = 0; i < ps->n; i++) {
    if (!ps->live[i]) continue;
    if (ps->keys[i].len != 9 || memcmp(ps->keys[i].p, "stoString", 9) != 0) continue;
    return (const omni_js_list_view *)ps->vals[i].u.ref;
  }
  return NULL;
}

/* 段那边那份"会调 toString 的转串"（见 omni.h）。递归深度那一格是防自套：
   str_v 里 toString 又交回来一个对象时它会落回 omni_js_str，那一路又会走到这儿 ——
   深度非零就直接按标签印（正是规范里"再试 valueOf，这个值域里没有那一格"的落点）。 */
static omni_js_prim_hook js_prim_hook = NULL;
static int js_prim_depth = 0;

void omni_js_prim_hook_set(omni_js_prim_hook h) { js_prim_hook = h; }

/* 容器与真对象那一族（ToPrimitive 要过一遍的那些）。函数不在里头：`f + 1` 在规范里是
   函数的源码文本，这个值域里没有那一格。 */
static bool js_objlike(omni_dyn v) {
  return v.tag == OMNI_DYN_OBJ || v.tag == OMNI_DYN_DICT || v.tag == OMNI_DYN_LIST
    || v.tag == OMNI_DYN_MAP || v.tag == OMNI_DYN_SET || v.tag == OMNI_DYN_RE;
}

static bool js_obj_has_own_tostring(omni_dyn v) {
  /* **继承来的那格 Object.prototype.toString 不算"自带"**（与 omni_js_own_ts_ 同一条判据）：
     realm 落地之后每个真对象的链上都有它，一律算自带的话 String(任何真对象) 都会当场报 ——
     class 的实例、globalThis 全中招（量出来的）。这儿认不出 realm 那张表（它住在生成单元的
     宏段里），所以按**链尾**认：链的末端那一格就是 Object.prototype，最近的那格 toString
     与链尾那格是同一个函数就是继承来的。 */
  const omni_js_list_view *near = NULL;
  const omni_js_list_view *tail = NULL;
  omni_dyn cur = v;
  while (cur.tag == OMNI_DYN_OBJ) {
    const omni_js_list_view *sl = js_obj_own_ts_slot_(cur);
    if (sl != NULL) {
      if (near == NULL) near = sl;
      tail = sl;
    }
    cur = ((const omni_js_objv *)cur.u.ref)->pr;
  }
  if (near != NULL) {
    /* 取值器（`get toString()`）一律算自带：realm 上那格是普通数据槽。 */
    if (near->items[1].u.b) return true;
    if (near->items[0].tag != OMNI_DYN_FN) return false;
    if (near == tail) return false;
    return near->items[0].u.ref != tail->items[0].u.ref;
  }
  if (cur.tag == OMNI_DYN_DICT) {
    const omni_dyn *ts = js_dict_find((const omni_js_dict_view *)cur.u.ref, "toString");
    return ts != NULL && ts->tag == OMNI_DYN_FN;
  }
  return false;
}

/* JS 域里的字符串一律是 str16（ADR-0011 第 8 节）。UTF-8 的 omni_str 只在
   转码的两个出入口出现，所以这里把 to_s16 收成一个内部函数，op 层只见 str16。 */
static omni_s16 to_s16(omni_dyn v) {
  switch (v.tag) {
    case OMNI_DYN_UNDEF: return omni_s16_of_utf8(omni_str_new("undefined", 9));
    case OMNI_DYN_NULL: return omni_s16_of_utf8(omni_str_new("null", 4));
    case OMNI_DYN_BOOL: return omni_s16_of_utf8(omni_str_bool(v.u.b));
    case OMNI_DYN_INT: return js_i64_s16(v.u.i);
    /* UINT 那一格印的是**无符号**的十进制：JS 那边它是一个真的大 BigInt */
    case OMNI_DYN_UINT:
      return omni_s16_of_utf8(omni_str_fmt("%llu", (unsigned long long)omni_dyn_u64(v)));
    /* 整数值的 real 也走那条（`-0` 到不了这儿：js_num_str 里 `v == 0.0` 先接了印 "0"，
       而这儿 `(int64_t)(-0.0)` 也是 0，两条给同一串字符） */
    case OMNI_DYN_REAL:
      if (v.u.r == floor(v.u.r) && v.u.r > -9007199254740992.0 && v.u.r < 9007199254740992.0) {
        return js_i64_s16((int64_t)v.u.r);
      }
      return omni_s16_of_utf8(js_num_str(v.u.r));
    case OMNI_DYN_STR16: return v.u.s16;
    /* String(/x/g) 是 "/x/g" —— 源与 flags 之间那两条斜杠是 JS 的字面量写法 */
    case OMNI_DYN_RE: {
      omni_js_re_obj *r = (omni_js_re_obj *)v.u.ref;
      omni_s16 slash = omni_s16_of_utf8(omni_str_new("/", 1));
      return omni_s16_cat(omni_s16_cat(omni_s16_cat(slash, r->src), slash), r->flags);
    }
    /* String(new Map()) 是 "[object Map]"：规范里它走 Object.prototype.toString，
       而那一格看的是 Symbol.toStringTag（Map / Set 各有一格）。这儿不用 realm ——
       照标签直说，与 prelude 的 $js_str 对着写。 */
    case OMNI_DYN_MAP: return omni_s16_of_utf8(omni_str_new("[object Map]", 12));
    case OMNI_DYN_SET: return omni_s16_of_utf8(omni_str_new("[object Set]", 12));
    /* String(Symbol("s")) 是 "Symbol(s)"。规范里 `"" + sym` 是 TypeError、只有 String()
       特批 —— 这个值域里两条路都落在这一格上，所以两边一致地给文本。与 prelude 的
       $js_str 同一个口径（ADR-0020 记着这一格是有意的分叉）。 */
    case OMNI_DYN_SYM: return omni_js_as_s16(omni_js_sym_str(v));
    /* String([1,2,"x"]) 是 "1,2,x"：规范 23.1.3.36 里 Array.prototype.toString 就是
       join(",")，而 join 把 null / undefined 那格写成空串、嵌套的数组递归下去。
       两把尺子在这一格上一致（量过），prelude 走宿主的 String() 也是这个答案 ——
       从前 C 这条腿在这儿硬报 "cannot convert list to string"，一条腿死、三条腿活。 */
    /* 真对象（ADR-0020 P1-c）：没有自己的 toString 时 String(o) 是 "[object Object]"
       （规范 20.1.3.6 走的是 Object.prototype.toString）。有自己那一格就当场报，
       理由见 js_obj_has_own_tostring 上面那段注。 */
    case OMNI_DYN_OBJ: {
      /* 串口径的 ToPrimitive 先过一遍钩子（Symbol.toPrimitive / 自带 toString / valueOf 都
         在它里头）：没有那几格时它把接收者原样交回来，于是落到下面按标签的那一句。
         钩子没登记（不是 JS 那条腿）而对象确实自带 toString 时照旧当场报。 */
      if (js_prim_hook != NULL && js_prim_depth == 0) {
        js_prim_depth++;
        omni_dyn r = js_prim_hook(v, 's');
        js_prim_depth--;
        /* 交回来的是原始值（可能是个数），所以还要按原始值那套印一遍 */
        if (!js_objlike(r)) return to_s16(r);
      } else if (js_prim_hook == NULL && js_obj_has_own_tostring(v)) {
        omni_errorf("backend-c: String() of an object with its own toString — "
                    "自带 toString 的对象现在只在 node 宿主上成立"
                    "（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器");
      }
      return omni_s16_of_utf8(omni_str_new("[object Object]", 15));
    }
    case OMNI_DYN_LIST: {
      const omni_js_list_view *l = (const omni_js_list_view *)v.u.ref;
      omni_s16 out = omni_s16_of_utf8(omni_str_new("", 0));
      if (js_s16_depth >= OMNI_JS_S16_MAX_DEPTH) {
        omni_errorf("String() of an array nested deeper than %d (a self-referential array?)",
                    OMNI_JS_S16_MAX_DEPTH);
        return out;
      }
      js_s16_depth++;
      for (int64_t i = 0; i < l->len; i++) {
        if (i > 0) out = omni_s16_cat(out, omni_s16_of_utf8(omni_str_new(",", 1)));
        omni_dyn e = l->items[i];
        if (e.tag == OMNI_DYN_NULL || e.tag == OMNI_DYN_UNDEF) continue;
        out = omni_s16_cat(out, to_s16(e));
      }
      js_s16_depth--;
      return out;
    }
    /* dict 有两副面孔。一副是**普通对象**（`{a:1}`）—— 规范里它走
       Object.prototype.toString，答案是 "[object Object]"。另一副是**异常对象**
       （ADR-0011 决策 15：带 $cls 的那种 dict）—— Error.prototype.toString 是
       "Name: message"，message 空时只剩 "Name"（规范 20.5.3.4）。 */
    case OMNI_DYN_DICT: {
      const omni_js_dict_view *d = (const omni_js_dict_view *)v.u.ref;
      if (js_dict_find(d, "$cls") == NULL) {
        /* 自带 toString 的那种对象（`{ toString() { return "T"; } }`）：规范的
           ToPrimitive 会**调**它。调回调要现拼一条实参 list，而 list 的具体类型只在
           生成的那个翻译单元里 —— 这儿造不出来。刻意当场报而不是给 "[object Object]"：
           那是一个悄悄的错答案，比拒绝坏（ADR-0020 的排序）。 */
        if (js_prim_hook != NULL && js_prim_depth == 0) {
          js_prim_depth++;
          omni_dyn r = js_prim_hook(v, 's');
          js_prim_depth--;
          if (!js_objlike(r)) return to_s16(r);
        } else if (js_prim_hook == NULL) {
          const omni_dyn *ts = js_dict_find(d, "toString");
          if (ts != NULL && ts->tag == OMNI_DYN_FN) {
            omni_errorf("backend-c: String() of an object with its own toString — "
                        "自带 toString 的对象现在只在 node 宿主上成立"
                        "（ADR-0020 P1-c）；这份程序请走 --backend js 或解释器");
          }
        }
        return omni_s16_of_utf8(omni_str_new("[object Object]", 15));
      }
      const omni_dyn *nm = js_dict_find(d, "name");
      const omni_dyn *ms = js_dict_find(d, "message");
      omni_s16 name = nm == NULL ? omni_s16_of_utf8(omni_str_new("Error", 5)) : to_s16(*nm);
      omni_s16 msg = ms == NULL ? omni_s16_of_utf8(omni_str_new("", 0)) : to_s16(*ms);
      if (msg.len == 0) return name;
      return omni_s16_cat(omni_s16_cat(name, omni_s16_of_utf8(omni_str_new(": ", 2))), msg);
    }
    default:
      omni_errorf("cannot convert %s to string", omni_dyn_tag_name(v.tag));
      return omni_s16_of_utf8(omni_str_new("", 0));
  }
}

omni_dyn omni_js_str(omni_dyn v) { return omni_dyn_of_s16(to_s16(v)); }

/* 规范意义上的 "Type(v) is Object"：不是那七格原始值就算（ADR-0020）。用处主要是构造器的
   return —— 返回数组、返回函数也算对象，所以判据不能只认某一个标签。
   与 prelude 的 $js_is_object 逐格对齐（那边是"不在 $JS_PRIMS 里"）。 */
bool omni_js_is_object(omni_dyn v) {
  switch (v.tag) {
    case OMNI_DYN_NULL: case OMNI_DYN_UNDEF: case OMNI_DYN_BOOL:
    case OMNI_DYN_INT: case OMNI_DYN_UINT: case OMNI_DYN_REAL:
    case OMNI_DYN_STR16: case OMNI_DYN_STRING: case OMNI_DYN_SYM:
      return false;
    default: return true;
  }
}

/* Object.prototype.toString.call(x)（规范 20.1.3.6）。规范先问 Symbol.toStringTag、再看
   内部槽；这条腿上**没有真对象**（还在 P1-c 里），所以既没有 toStringTag 也没有原型链 ——
   照标签直说，与 prelude 的 $js_obj_to_string 那个 switch 逐支对齐。
   WeakMap / WeakSet 在这个值域里就是 Map / Set（ADR-0020 P4 画的边界），所以也报 Map / Set。 */
/* 函数值的 name / length 那张按 fp 索引的表（见 omni.h 上的那段说明）。生成的代码在 main 里
   登记一次，这儿只存指针 —— 表是静态的、活得比程序里任何一格闭包都长。
   查表是线性的：读 `f.name` 是冷路径（造闭包才是热路径，而那条路一点没动）。 */
/* **一段一格**（切文件之后这张表是分片的）：表里每条都要拿一个函数指针，而取一个
   *别的翻译单元*里的函数的地址要一条重定位 —— 我们的后端在 CALL 上有、取地址还没有
   （tcc 的 `adrp+add` 那一对）。所以每个 TU 登记自己那一段，`set` 是**追加**不是覆盖。
   64 段是上限：一份程序的单元数超过它就只是查不到 name/length（不崩、不错答案）。 */
#define OMNI_JS_FNMETA_SEGS 64
static const omni_js_fn_meta *js_fnmeta_t[OMNI_JS_FNMETA_SEGS];
static int64_t js_fnmeta_c[OMNI_JS_FNMETA_SEGS];
static int js_fnmeta_ns = 0;

void omni_js_fnmeta_set(const omni_js_fn_meta *t, int64_t n) {
  if (js_fnmeta_ns >= OMNI_JS_FNMETA_SEGS) return;
  js_fnmeta_t[js_fnmeta_ns] = t;
  js_fnmeta_c[js_fnmeta_ns] = n;
  js_fnmeta_ns++;
}

const omni_js_fn_meta *omni_js_fnmeta_find(const void *fp) {
  for (int s = 0; s < js_fnmeta_ns; s++) {
    for (int64_t i = 0; i < js_fnmeta_c[s]; i++) {
      if (js_fnmeta_t[s][i].fp == fp) return &js_fnmeta_t[s][i];
    }
  }
  return NULL;
}

omni_dyn omni_js_obj_to_string(omni_dyn t) {
  const char *n;
  switch (t.tag) {
    case OMNI_DYN_UNDEF: n = "[object Undefined]"; break;
    case OMNI_DYN_NULL: n = "[object Null]"; break;
    case OMNI_DYN_LIST: n = "[object Array]"; break;
    case OMNI_DYN_STR16: case OMNI_DYN_STRING: n = "[object String]"; break;
    case OMNI_DYN_REAL: case OMNI_DYN_INT: case OMNI_DYN_UINT: n = "[object Number]"; break;
    case OMNI_DYN_BOOL: n = "[object Boolean]"; break;
    case OMNI_DYN_FN: n = "[object Function]"; break;
    case OMNI_DYN_MAP: n = "[object Map]"; break;
    case OMNI_DYN_SET: n = "[object Set]"; break;
    case OMNI_DYN_RE: n = "[object RegExp]"; break;
    case OMNI_DYN_SYM: n = "[object Symbol]"; break;
    default: n = "[object Object]"; break;
  }
  /* 常量串不必过一遍 snprintf：of_utf8 那张 intern 表会把它认出来（omni_str16.c）。
     量出来的：printf 那一族约 625 个样本，其中 485 落在 omni_js_typeof 这一条上。 */
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new(n, (int64_t)strlen(n))));
}

/* console.log 印一格值：与 ToString 只差一处 —— **-0 印成 "-0"**（String(-0) 是 "0"，
   而 qjs 与 node 的 console.log 都印 -0，量过）。 */
omni_dyn omni_js_disp(omni_dyn v) {
  if (v.tag == OMNI_DYN_REAL && v.u.r == 0.0 && signbit(v.u.r)) {
    return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("-0", 2)));
  }
  /* bigint 的显示文本**不带 n**（两把尺子都印 30n，这里是有意的分叉）：这个值域里
     JS 的 bigint 与方言的 int64 是同一个标签（OMNI_DYN_INT/UINT），C 这条腿分不开
     "JS 里的 30n" 与 "方言里的 int 30" —— 加上 n 会让方言的 println 全都变成 77n
     （量出来的：tests/oir 的 whole program）。见 ADR-0020 的口径那一节。 */
  return omni_js_str(v);
}

/* 输出：JS 的 String 是 UTF-16，落到 stdout 得转回 UTF-8。这个 op 存在的意义
   是让"什么时候转码"变成一处显式的边界，而不是散落在各个打印点上。 */
void omni_js_println(omni_dyn v) {
  omni_str s = omni_s16_to_utf8(to_s16(omni_js_disp(v)));
  printf("%.*s\n", (int)s.len, s.p);
}

/* ---------------------------------------------------------------- 算术 */

/* int 那一族有两个标签：INT 与 UINT（无符号 64 位那一半，见 omni.h）。
   "是不是 bigint" 一律问 is_int，不要直接比 OMNI_DYN_INT —— 漏一处就是 JS 侧收下、
   C 侧报错的分叉。 */
static bool is_int(omni_dyn v) { return v.tag == OMNI_DYN_INT || v.tag == OMNI_DYN_UINT; }
static bool is_num(omni_dyn v) { return is_int(v) || v.tag == OMNI_DYN_REAL; }
static double as_f64(omni_dyn v) {
  if (v.tag == OMNI_DYN_INT) return (double)v.u.i;
  if (v.tag == OMNI_DYN_UINT) return (double)omni_dyn_u64(v);
  return v.u.r;
}

/* 两个 bigint 的三态比较，**精确**：转 double 会在 2^53 以上丢位，而 JS 那边
   BigInt 的比较是精确的 —— 两侧都得精确，否则大数上直接分叉。
   INT 与 UINT 的取值区间不交（UINT 一律 >= 2^63），所以混标签只看谁是 UINT。 */
static int int_cmp(omni_dyn a, omni_dyn b) {
  if (a.tag == OMNI_DYN_UINT || b.tag == OMNI_DYN_UINT) {
    if (a.tag != OMNI_DYN_UINT) return -1;
    if (b.tag != OMNI_DYN_UINT) return 1;
    return omni_dyn_u64(a) < omni_dyn_u64(b) ? -1 : (omni_dyn_u64(a) > omni_dyn_u64(b) ? 1 : 0);
  }
  return a.u.i < b.u.i ? -1 : (a.u.i > b.u.i ? 1 : 0);
}

static void want_num(int op, omni_dyn a, omni_dyn b) {
  if (!is_num(a) || !is_num(b)) {
    omni_errorf("cannot apply '%c' to %s and %s", op,
                omni_dyn_tag_name(a.tag), omni_dyn_tag_name(b.tag));
  }
  /* JS 里 BigInt 与 Number 混用是 TypeError；这条一定要保留，否则源码里 int/real
     混错的地方会被悄悄接受，而 JS 宿主上会抛异常 —— 两个后端就分叉了。
     INT 与 UINT 都算 bigint 那一边，所以问的是 is_int 而不是 tag 相等。 */
  if (is_int(a) != is_int(b)) {
    omni_errorf("cannot mix bigint and number in '%c'", op);
  }
}

/* 非数的原始值先 ToNumber（规范 ApplyStringOrNumericBinaryOperator 第 3 步的 ToNumeric）：
   "3" * "4" 是 12、true + true 是 2、null + 1 是 1。bigint 不转（混着算照旧由 want_num
   当场报），判据与 prelude 的 $js_tonum 相同。 */
/* 一格值的 ToPrimitive（规范 7.1.1，hint 是 default）。这个值域里 valueOf 那一格
   在任何对象上都只会交回自己，所以答案只由"自带的 toString"决定：有就调它（段那边那份
   钩子），没有就落回按标签的那串（数组是 join(",")、普通对象是 "[object Object]"…）。
   段没登记钩子的时候（不是 JS 那条腿）objlike 一律落回按标签的串 —— 与从前"当场报"相比，
   这是把**规范里本来就有的答案**给出来，不是猜。 */
omni_dyn omni_js_to_prim_c(omni_dyn v, int hint) {
  if (!js_objlike(v)) return v;
  if (js_prim_hook != NULL && js_prim_depth == 0) {
    js_prim_depth++;
    omni_dyn r = js_prim_hook(v, hint);
    js_prim_depth--;
    if (!js_objlike(r)) return r;
  }
  return omni_dyn_of_s16(to_s16(v));
}

static omni_dyn to_num1(omni_dyn v) {
  if (is_int(v) || v.tag == OMNI_DYN_REAL) return v;
  /* 对象先 ToPrimitive（`[3] * 2` 是 6、`{} * 2` 是 NaN）—— 从前这儿掉进
     omni_js_num_of 的那句 "cannot convert list to a number"，一条腿死、三条腿活。 */
  if (js_objlike(v)) v = omni_js_to_prim_c(v, 'n');
  return omni_js_num_of(v);
}

omni_dyn omni_js_add(omni_dyn a, omni_dyn b) {
  /* 对象操作数先 ToPrimitive（规范 13.15.3 第 3 步）：`[1,2] + 1` 是 "1,21"、
     `{toString(){return 42}} + 1` 是 43（数，不是串）。次序也照规范：两边都先取到原始值，
     **然后**才看有没有串。 */
  if (js_objlike(a)) a = omni_js_to_prim_c(a, 'd');
  if (js_objlike(b)) b = omni_js_to_prim_c(b, 'd');
  if (a.tag == OMNI_DYN_STR16 || b.tag == OMNI_DYN_STR16) {
    return omni_dyn_of_s16(omni_s16_cat(to_s16(a), to_s16(b)));
  }
  a = to_num1(a);
  b = to_num1(b);
  want_num('+', a, b);
  if (is_int(a)) return omni_dyn_of_int(omni_add(a.u.i, b.u.i));
  return omni_dyn_of_real(a.u.r + b.u.r);
}

/* `**` 的 int 那一支：平方求幂，每一步都回卷（omni_mul 就是回卷的乘）。回卷是模 2^64 的
   环同态，所以这与"先算精确值再回卷"逐位相同 —— 与 JS 侧的 $js_ipow 是同一份算法。 */
static int64_t js_ipow(int64_t a, int64_t b) {
  int64_t r = 1, x = a;
  uint64_t n;
  if (b < 0) omni_errorf("exponent must not be negative in '**' with bigint operands");
  n = (uint64_t)b;
  while (n > 0) {
    if (n & 1u) r = omni_mul(r, x);
    x = omni_mul(x, x);
    n >>= 1;
  }
  return r;
}

omni_dyn omni_js_arith(int op, omni_dyn a, omni_dyn b) {
  a = to_num1(a);
  b = to_num1(b);
  want_num(op, a, b);
  if (is_int(a)) {
    /* 除与取余要看**符号性**：别的运算（- * p）都是回卷的，回卷是模 2^64 的环同态，
       所以在位模式上算一遍就够，有符号那一支的代码逐位给出同一个答案。
       量到的用法只有 u/ 与 u%（interp/builtin.js 的 udiv/umod）—— 这两个在
       [0, 2^64) 里不会溢出，所以结果照 omni_dyn_of_uint64 规范化回来。 */
    if (a.tag == OMNI_DYN_UINT || b.tag == OMNI_DYN_UINT) {
      uint64_t x = omni_dyn_u64(a), y = omni_dyn_u64(b);
      if ((op == '/' || op == '%') && y == 0) omni_error("division by zero");
      if (op == '/') return omni_dyn_of_uint64(x / y);
      if (op == '%') return omni_dyn_of_uint64(x % y);
    }
    switch (op) {
      case '-': return omni_dyn_of_int(omni_sub(a.u.i, b.u.i));
      case '*': return omni_dyn_of_int(omni_mul(a.u.i, b.u.i));
      case '/': return omni_dyn_of_int(omni_div(a.u.i, b.u.i));
      case '%': return omni_dyn_of_int(omni_mod(a.u.i, b.u.i));
      case 'p': return omni_dyn_of_int(js_ipow(a.u.i, b.u.i));
      default: omni_errorf("unknown arithmetic op '%c'", op);
    }
  }
  switch (op) {
    case '-': return omni_dyn_of_real(a.u.r - b.u.r);
    case '*': return omni_dyn_of_real(a.u.r * b.u.r);
    case '/': return omni_dyn_of_real(a.u.r / b.u.r);
    case '%': return omni_dyn_of_real(fmod(a.u.r, b.u.r));
    case 'p': return omni_dyn_of_real(pow(a.u.r, b.u.r));
    default: omni_errorf("unknown arithmetic op '%c'", op);
  }
  return omni_dyn_null();
}

omni_dyn omni_js_neg(omni_dyn a) {
  /* $W(-a)：UINT 走同一支 —— 回卷之后位模式与有符号那一支相同 */
  if (is_int(a)) return omni_dyn_of_int(omni_neg(a.u.i));
  if (a.tag == OMNI_DYN_REAL) return omni_dyn_of_real(-a.u.r);
  /* 别的一律先 ToNumber（规范 13.5.5：一元负号先 ToNumeric）：-"3" 是 -3、-true 是 -1。
     判据与 prelude 的 $js_neg 相同 —— 从前这儿是 "cannot negate string"。 */
  return omni_dyn_of_real(-omni_js_num_of(a).u.r);
}

/* `++` / `--`（规范 13.4.4.1）：**先 ToNumeric，再按那个数值类型加/减 1**。
 * int 那一支走回卷的 int64 加法（这个值域里的 int 就是 int64），别的先 ToNumber。
 * 与 prelude 的 `$js_inc` / `$js_dec` 一一对应。降级器从前发的是 `js_add(x, 1)`，
 * 于是 bigint 上撞 "cannot mix bigint and number"、串上 `"5"++` 拼成 `"51"`。 */
omni_dyn omni_js_inc(omni_dyn v) {
  if (is_int(v)) return omni_dyn_of_int(omni_add(v.u.i, 1));
  return omni_dyn_of_real(omni_js_num_of(v).u.r + 1.0);
}

omni_dyn omni_js_dec(omni_dyn v) {
  if (is_int(v)) return omni_dyn_of_int(omni_sub(v.u.i, 1));
  return omni_dyn_of_real(omni_js_num_of(v).u.r - 1.0);
}

/* Number 上的位运算：先 ToInt32（规范 7.1.6），结果是 Number。int（= BigInt）那一支照旧
   按 64 位算 —— JS 里 bigint 与 number 混着做位运算是 TypeError，而这个值域里两者同一个
   标签，所以判据只能是"两边都 int 才按 64 位算"。判据与 prelude 的 $js_toi32 相同。 */
static int32_t to_i32(omni_dyn v) {
  if (is_int(v)) return (int32_t)(uint32_t)(uint64_t)v.u.i;
  double d = to_num1(v).u.r;
  if (!isfinite(d)) return 0;
  double m = fmod(trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (int32_t)(uint32_t)m;
}

omni_dyn omni_js_bitop(int op, omni_dyn a, omni_dyn b) {
  if (!is_int(a) || !is_int(b)) {
    int32_t x = to_i32(a), y = to_i32(b);
    switch (op) {
      case '&': return omni_dyn_of_real((double)(x & y));
      case '|': return omni_dyn_of_real((double)(x | y));
      case '^': return omni_dyn_of_real((double)(x ^ y));
      case '<': return omni_dyn_of_real((double)(int32_t)((uint32_t)x << (y & 31)));
      case '>': return omni_dyn_of_real((double)(x >> (y & 31)));
      default: omni_errorf("unknown bitwise op '%c'", op);
    }
  }
  /* 有 UINT 参与时，& | ^ 的结果可能还在 [2^63, 2^64) 里（JS 侧这三个不回卷），
     所以走规范化构造；>> 在 JS 里对非负的 BigInt 是逻辑右移，这里也必须逻辑移。
     << 照旧：它在 JS 侧带 $W，回卷之后位模式与有符号那一支相同。 */
  if (a.tag == OMNI_DYN_UINT || b.tag == OMNI_DYN_UINT) {
    uint64_t x = omni_dyn_u64(a), y = omni_dyn_u64(b);
    switch (op) {
      case '&': return omni_dyn_of_uint64(x & y);
      case '|': return omni_dyn_of_uint64(x | y);
      case '^': return omni_dyn_of_uint64(x ^ y);
      case '>':
        if (a.tag == OMNI_DYN_UINT) return omni_dyn_of_uint64(x >> (unsigned)(y & 63));
        break;
      default: break;
    }
  }
  switch (op) {
    case '&': return omni_dyn_of_int(a.u.i & b.u.i);
    case '|': return omni_dyn_of_int(a.u.i | b.u.i);
    case '^': return omni_dyn_of_int(a.u.i ^ b.u.i);
    case '<': return omni_dyn_of_int(omni_shl(a.u.i, b.u.i));
    case '>': return omni_dyn_of_int(omni_shr(a.u.i, b.u.i));
    default: omni_errorf("unknown bitwise op '%c'", op);
  }
  return omni_dyn_null();
}

/* 一元 ~ 单独一个 op：ABI 里所有 op 的实参个数是定的，不做可变长 */
omni_dyn omni_js_bitnot(omni_dyn a) {
  if (!is_int(a)) return omni_dyn_of_real((double)(~to_i32(a)));
  /* $W(~a)：UINT 走同一支，回卷之后位模式相同 */
  return omni_dyn_of_int(~a.u.i);
}

/* ------------------------------------------------ throw / try（ADR-0007 决定 1）
 *
 * 错误传播只做静态降级：没有 setjmp/longjmp，也不映射到宿主的 throw。运行时这一层
 * 只有一个"待处理错误"的槽 —— throw 往里放，每个可能出错的调用点之后查一下，
 * catch 取出来并清空。跳转本身是普通控制流，由 lower.js 发出来（ADR-0011 第 5 步）。
 *
 * 单线程假设：Omni 现在没有线程。真要有的话这个槽跟着线程走，不影响上面的形状。
 */
static omni_dyn pending_err;
static bool pending_set;

omni_dyn omni_js_throw(omni_dyn v) {
  pending_err = v;
  pending_set = true;
  return omni_dyn_undef();
}

bool omni_js_pending(void) { return pending_set; }

omni_dyn omni_js_take_pending(void) {
  if (!pending_set) return omni_dyn_undef();
  pending_set = false;
  return pending_err;
}

/* 没人接的错误：生成的 main 在入口返回之后查一次。宿主里未捕获的异常会打栈回溯，
   C 侧打不出同样的东西，所以两侧一律只打这一行 —— 分叉点越少越好。 */
void omni_js_check_uncaught(void) {
  if (!pending_set) return;
  omni_str s = omni_s16_to_utf8(omni_js_as_s16(omni_js_str(pending_err)));
  fflush(stdout);
  fprintf(stderr, "omni: uncaught: %.*s\n", (int)s.len, s.p);
  exit(70);
}

/* ---------------------------------------------------------------- 比较 */

bool omni_js_cmp(int op, omni_dyn a, omni_dyn b) {
  int c;
  if (a.tag == OMNI_DYN_STR16 && b.tag == OMNI_DYN_STR16) {
    c = omni_s16_cmp(a.u.s16, b.u.s16);
  } else {
    /* 混着比（"2" > 1、null >= 0、undefined > 0）：规范 7.2.13 —— 只有两边都是串才按串比，
       否则**两边都 ToNumber**（串解析不动是 NaN，NaN 上一切关系比较都 false）。
       与 prelude 的 $js_cmp 对着写；从前这儿是当场报错。 */
    if (!is_num(a)) a = omni_js_num_of(a);
    if (!is_num(b)) b = omni_js_num_of(b);
    /* 两个 bigint 之间精确比（转 double 在 2^53 以上丢位，JS 那边是精确的）；
       只要有一边是 real 就照 JS 的口径转 double 再比 */
    if (is_int(a) && is_int(b)) {
      c = int_cmp(a, b);
    } else {
      double x = as_f64(a), y = as_f64(b);
      /* NaN 参与的关系比较全为假，这一条不能靠 c 的三态表达 */
      if (isnan(x) || isnan(y)) return false;
      c = x < y ? -1 : (x > y ? 1 : 0);
    }
  }
  switch (op) {
    case '<': return c < 0;
    case '>': return c > 0;
    case 'l': return c <= 0;
    case 'g': return c >= 0;
    default: omni_errorf("unknown comparison op '%c'", op);
  }
  return false;
}

bool omni_js_eq(bool strict, omni_dyn a, omni_dyn b) {
  if (!strict) {
    /* == 的强制转换只保留编译器源码真正会用到的两条：
       null 与 undefined 互等；bigint 与 number 按数值比 */
    bool an = a.tag == OMNI_DYN_NULL || a.tag == OMNI_DYN_UNDEF;
    bool bn = b.tag == OMNI_DYN_NULL || b.tag == OMNI_DYN_UNDEF;
    if (an || bn) return an && bn;
    if (is_num(a) && is_num(b)) {
      /* 两个 bigint 精确比，其余（有 real 参与）照 JS 转 double */
      if (is_int(a) && is_int(b)) return int_cmp(a, b) == 0;
      return as_f64(a) == as_f64(b);
    }
  }
  if (a.tag != b.tag) return false;
  switch (a.tag) {
    case OMNI_DYN_UNDEF: case OMNI_DYN_NULL: return true;
    case OMNI_DYN_BOOL: return a.u.b == b.u.b;
    case OMNI_DYN_INT: case OMNI_DYN_UINT: return a.u.i == b.u.i;
    /* === 下 NaN 不等于自身、+0 等于 -0（这和 dict 键用的 SameValueZero 不同） */
    case OMNI_DYN_REAL: return a.u.r == b.u.r;
    case OMNI_DYN_STR16: return omni_s16_eq(a.u.s16, b.u.s16);
    default: return a.u.ref == b.u.ref;  /* 对象/数组/函数比同一性 */
  }
}

/* Object.is（SameValue，规范 7.2.11）：与 === 只差两格 —— NaN 与自己相同、+0 与 -0 不同。
   与 prelude 的 $js_same_value 同一套分工：处理那两格，剩下的转手严格相等。 */
bool omni_js_same_value(omni_dyn a, omni_dyn b) {
  if (a.tag == OMNI_DYN_REAL && b.tag == OMNI_DYN_REAL) {
    if (isnan(a.u.r) && isnan(b.u.r)) return true;
    if (a.u.r == 0 && b.u.r == 0) return signbit(a.u.r) == signbit(b.u.r);
  }
  return omni_js_eq(true, a, b);
}

/* ------------------------------------------------ 字节缓冲（ADR-0011）
 *
 * ArrayBuffer 与它上面的 Uint8Array / DataView 是同一种值：一个 {p, len} 视图。
 * 存取一律**显式按字节拼**，不 memcpy 一个 int64/double 下去 —— 这样与宿主的 DataView
 * 逐位相同，不看机器的字节序。每一条错误文本都要与 prelude 里那一份逐字相同。
 */

static omni_js_bytes *want_bytes(omni_dyn v, const char *who) {
  if (v.tag != OMNI_DYN_BYTES) {
    omni_errorf("%s expects a byte buffer, found %s", who, omni_dyn_tag_name(v.tag));
  }
  return (omni_js_bytes *)v.u.ref;
}

/* 与 prelude 的 $js_real 同一套：real 直接用，int 转 double，别的报错 */
static double want_bufnum(omni_dyn v, const char *who) {
  if (v.tag == OMNI_DYN_REAL) return v.u.r;
  if (is_int(v)) return as_f64(v);
  omni_errorf("%s expects a number, found %s", who, omni_dyn_tag_name(v.tag));
  return 0;
}

/* JS 的 `x & 255`：ToInt32 之后取低 8 位，等价于按 2^32 取模再截 */
static uint8_t js_to_u8(double d) {
  if (!isfinite(d)) return 0;
  d = trunc(d);
  d = fmod(d, 4294967296.0);
  if (d < 0) d += 4294967296.0;
  return (uint8_t)((uint64_t)d & 255u);
}

static omni_dyn bytes_wrap(uint8_t *p, int64_t len) {
  omni_js_bytes *b = (omni_js_bytes *)omni_alloc(sizeof(omni_js_bytes));
  b->p = p;
  b->len = len;
  return omni_dyn_of_ref((void *)b, OMNI_DYN_BYTES);
}

omni_dyn omni_js_buf_new(omni_dyn n) {
  double d = want_bufnum(n, "new ArrayBuffer");
  int64_t len;
  uint8_t *p;
  if (!(d >= 0 && d == trunc(d) && d < 9.2233720368547758e18)) omni_error("invalid byte length");
  len = (int64_t)d;
  p = (uint8_t *)omni_alloc((size_t)(len == 0 ? 1 : len));
  if (len > 0) memset(p, 0, (size_t)len);
  return bytes_wrap(p, len);
}

omni_dyn omni_js_buf_view(omni_dyn bd, omni_dyn off, omni_dyn len) {
  omni_js_bytes *b;
  double od, nd;
  /* new Uint8Array(n) 那一支：实参是个数就是"新开 n 字节"，不是开视图 */
  if (bd.tag == OMNI_DYN_REAL) return omni_js_buf_new(bd);
  b = want_bytes(bd, "a byte-buffer view");
  od = off.tag == OMNI_DYN_UNDEF ? 0 : want_bufnum(off, "a byte-buffer view");
  nd = len.tag == OMNI_DYN_UNDEF ? (double)b->len - od : want_bufnum(len, "a byte-buffer view");
  if (!(od == trunc(od) && nd == trunc(nd) && od >= 0 && nd >= 0 && od + nd <= (double)b->len)) {
    omni_error("byte-buffer view out of range");
  }
  return bytes_wrap(b->p + (int64_t)od, (int64_t)nd);
}

omni_dyn omni_js_buf_len(omni_dyn b) {
  return omni_dyn_of_real((double)want_bytes(b, ".length")->len);
}

/* `.buffer` / `.byteOffset`（第一百四十片）：这一格里视图**就是**缓冲，所以 `.buffer`
 * 回它自己、`.byteOffset` 回 0，与 prelude 的 `$js_buf_buffer` / `$js_buf_byte_off`
 * 一一对应。照旧先过一次 `want_bytes` —— 别的标签上读这两个名字要照样报错。
 * 少了这两格的症状：装好的编译器一编 C 就是
 * `a byte-buffer view expects a byte buffer, found undefined`（那个 undefined 就是
 * 读不着的 `.buffer`），于是 `OMNI_CC=self` 出的编译器编不了 C。 */
omni_dyn omni_js_buf_buffer(omni_dyn b) {
  want_bytes(b, ".buffer");
  return b;
}

omni_dyn omni_js_buf_byte_off(omni_dyn b) {
  want_bytes(b, ".byteOffset");
  return omni_dyn_of_real(0);
}

/* `.subarray` / `.slice` 的一段下标（规范 23.2.3.28 / 23.2.3.27）：负数从末尾数、
 * 夹到 [0, len]，末端不小于起点。与 prelude 的 `$js_buf_span` 一字对着写。 */
static int64_t buf_rel(omni_dyn v, int64_t dflt, int64_t len, const char *who) {
  double d;
  int64_t i;
  if (v.tag == OMNI_DYN_UNDEF) return dflt;
  d = want_bufnum(v, who);
  i = d != d ? 0 : (int64_t)trunc(d);   /* NaN 当 0，与 $js_idx 一样 */
  if (i < 0) i += len;
  if (i < 0) return 0;
  return i > len ? len : i;
}

omni_dyn omni_js_buf_sub(omni_dyn bd, omni_dyn s, omni_dyn e) {
  omni_js_bytes *b = want_bytes(bd, ".subarray");
  int64_t a = buf_rel(s, 0, b->len, ".subarray");
  int64_t z = buf_rel(e, b->len, b->len, ".subarray");
  if (z < a) z = a;
  return bytes_wrap(b->p + a, z - a);   /* **视图**：不拷 */
}

omni_dyn omni_js_buf_slice(omni_dyn bd, omni_dyn s, omni_dyn e) {
  omni_js_bytes *b = want_bytes(bd, ".slice");
  int64_t a = buf_rel(s, 0, b->len, ".slice");
  int64_t z = buf_rel(e, b->len, b->len, ".slice");
  int64_t n;
  uint8_t *p;
  if (z < a) z = a;
  n = z - a;
  p = (uint8_t *)omni_alloc((size_t)(n == 0 ? 1 : n));
  if (n > 0) memcpy(p, b->p + a, (size_t)n);   /* **拷贝**：与视图那一格的唯一差别 */
  return bytes_wrap(p, n);
}

/* 用 memmove：两个视图可能落在同一块内存上并且重叠，宿主的 TypedArray.set 也是安全的 */
/* .set(src[, offset])（规范 23.2.3.26）与 .fill(v[, start[, end]])（23.2.3.9）：
   从前这两格的 op 少一/两个形参，成员派发器把多出来的实参**静静地丢了** ——
   d.set(src, 2) 写到 0 去、f.fill(9, 1, 3) 把整格填满。与 prelude 那两格对着写：
   下标照数组那一族的规矩，负数从末尾数，夹到 [0, len]。 */
static int64_t buf_clamp(omni_dyn v, int64_t dflt, int64_t len, const char *who) {
  double d;
  int64_t i;
  if (v.tag == OMNI_DYN_UNDEF) return dflt;
  d = want_bufnum(v, who);
  i = (int64_t)trunc(d);
  if (i < 0) i += len;
  if (i < 0) return 0;
  return i > len ? len : i;
}
void omni_js_buf_set(omni_dyn dst, omni_dyn src, omni_dyn off) {
  omni_js_bytes *d = want_bytes(dst, ".set");
  omni_js_bytes *s = want_bytes(src, ".set");
  int64_t o = off.tag == OMNI_DYN_UNDEF ? 0 : (int64_t)trunc(want_bufnum(off, ".set"));
  if (o < 0) omni_error("byte-buffer .set offset is out of range");
  if (s->len + o > d->len) omni_error("byte-buffer .set source is too long");
  if (s->len > 0) memmove(d->p + o, s->p, (size_t)s->len);
}

omni_dyn omni_js_buf_fill(omni_dyn bd, omni_dyn v, omni_dyn start, omni_dyn end) {
  omni_js_bytes *b = want_bytes(bd, ".fill");
  uint8_t x = js_to_u8(want_bufnum(v, ".fill"));
  int64_t a = buf_clamp(start, 0, b->len, ".fill");
  int64_t z = buf_clamp(end, b->len, b->len, ".fill");
  if (z > a) memset(b->p + a, (int)x, (size_t)(z - a));
  return bd;
}

static int64_t buf_at(omni_js_bytes *b, omni_dyn at, int64_t size, const char *who) {
  double d = want_bufnum(at, who);
  if (!(d == trunc(d) && d >= 0 && d + (double)size <= (double)b->len)) {
    omni_errorf("%s offset is outside the bounds of the buffer", who);
  }
  return (int64_t)d;
}

static uint64_t buf_rd8(const uint8_t *p, bool le) {
  uint64_t x = 0;
  int i;
  for (i = 0; i < 8; i++) x |= (uint64_t)p[le ? i : 7 - i] << (8 * i);
  return x;
}

static void buf_wr8(uint8_t *p, uint64_t x, bool le) {
  int i;
  for (i = 0; i < 8; i++) p[le ? i : 7 - i] = (uint8_t)((x >> (8 * i)) & 0xffu);
}

omni_dyn omni_js_buf_get_u8(omni_dyn bd, omni_dyn at) {
  omni_js_bytes *b = want_bytes(bd, ".getUint8");
  return omni_dyn_of_real((double)b->p[buf_at(b, at, 1, ".getUint8")]);
}

void omni_js_buf_set_u8(omni_dyn bd, omni_dyn at, omni_dyn v) {
  omni_js_bytes *b = want_bytes(bd, ".setUint8");
  int64_t o = buf_at(b, at, 1, ".setUint8");
  b->p[o] = js_to_u8(want_bufnum(v, ".setUint8"));
}

/* DataView 的定宽整数与 float32（ADR-0020 P4）。宽度走 sel（见 hir/js_abi.js 的
   js_buf_getn）：'b' int8 / 'B' uint8 / 'h' int16 / 'H' uint16 / 'i' int32 /
   'I' uint32 / 'f' float32。错误文本里的方法名要与 prelude 那份逐字相同。 */
static const char *buf_wname(int sel) {
  switch (sel) {
    case 'b': return "Int8";
    case 'B': return "Uint8";
    case 'h': return "Int16";
    case 'H': return "Uint16";
    case 'i': return "Int32";
    case 'I': return "Uint32";
    default: return "Float32";
  }
}

static int buf_wsize(int sel) {
  if (sel == 'b' || sel == 'B') return 1;
  if (sel == 'h' || sel == 'H') return 2;
  return 4;
}

static uint64_t buf_rdn(const uint8_t *p, int n, bool le) {
  uint64_t x = 0;
  int i;
  for (i = 0; i < n; i++) x |= (uint64_t)p[le ? i : n - 1 - i] << (8 * i);
  return x;
}

static void buf_wrn(uint8_t *p, uint64_t x, int n, bool le) {
  int i;
  for (i = 0; i < n; i++) p[le ? i : n - 1 - i] = (uint8_t)((x >> (8 * i)) & 0xffu);
}

/* JS 存整数的口径（规范 SetValueInBuffer）：先 ToIntegerOrInfinity 再取模 2^(8n)。
   非有限数一律 0 —— 宿主的 DataView.set* 就是这么做的，两边必须同样。 */
static uint64_t buf_to_int(double d, int n) {
  double mod = ldexp(1.0, 8 * n);
  double t;
  if (!isfinite(d)) return 0;
  t = fmod(trunc(d), mod);
  if (t < 0) t += mod;
  return (uint64_t)t;
}

omni_dyn omni_js_buf_getn(int sel, omni_dyn bd, omni_dyn at, omni_dyn le) {
  char who[32];
  omni_js_bytes *b;
  int n = buf_wsize(sel);
  int64_t o;
  uint64_t raw;
  snprintf(who, sizeof who, ".get%s", buf_wname(sel));
  b = want_bytes(bd, who);
  o = buf_at(b, at, n, who);
  raw = buf_rdn(b->p + o, n, omni_js_truthy(le));
  switch (sel) {
    case 'b': return omni_dyn_of_real((double)(int8_t)(uint8_t)raw);
    case 'B': return omni_dyn_of_real((double)(uint8_t)raw);
    case 'h': return omni_dyn_of_real((double)(int16_t)(uint16_t)raw);
    case 'H': return omni_dyn_of_real((double)(uint16_t)raw);
    case 'i': return omni_dyn_of_real((double)(int32_t)(uint32_t)raw);
    case 'I': return omni_dyn_of_real((double)(uint32_t)raw);
    default: {
      union { uint32_t u; float f; } u;
      u.u = (uint32_t)raw;
      return omni_dyn_of_real((double)u.f);
    }
  }
}

void omni_js_buf_setn(int sel, omni_dyn bd, omni_dyn at, omni_dyn v, omni_dyn le) {
  char who[32];
  omni_js_bytes *b;
  int n = buf_wsize(sel);
  int64_t o;
  double d;
  uint64_t raw;
  snprintf(who, sizeof who, ".set%s", buf_wname(sel));
  b = want_bytes(bd, who);
  d = want_bufnum(v, who);
  o = buf_at(b, at, n, who);
  if (sel == 'f') {
    union { uint32_t u; float f; } u;
    u.f = (float)d;
    raw = u.u;
  } else {
    raw = buf_to_int(d, n);
  }
  buf_wrn(b->p + o, raw, n, omni_js_truthy(le));
}

omni_dyn omni_js_buf_get_i64(omni_dyn bd, omni_dyn at, omni_dyn le) {
  omni_js_bytes *b = want_bytes(bd, ".getBigInt64");
  int64_t o = buf_at(b, at, 8, ".getBigInt64");
  return omni_dyn_of_int((int64_t)buf_rd8(b->p + o, omni_js_truthy(le)));
}

void omni_js_buf_set_i64(omni_dyn bd, omni_dyn at, omni_dyn v, omni_dyn le) {
  omni_js_bytes *b = want_bytes(bd, ".setBigInt64");
  int64_t o;
  /* 查标签在查偏移之前 —— 与 prelude 里那一份同一个顺序，报错才是同一句 */
  if (!is_int(v)) {
    omni_errorf(".setBigInt64 expects a bigint, found %s", omni_dyn_tag_name(v.tag));
  }
  o = buf_at(b, at, 8, ".setBigInt64");
  buf_wr8(b->p + o, (uint64_t)v.u.i, omni_js_truthy(le));
}

omni_dyn omni_js_buf_get_f64(omni_dyn bd, omni_dyn at, omni_dyn le) {
  omni_js_bytes *b = want_bytes(bd, ".getFloat64");
  int64_t o = buf_at(b, at, 8, ".getFloat64");
  union { uint64_t u; double d; } u;
  u.u = buf_rd8(b->p + o, omni_js_truthy(le));
  return omni_dyn_of_real(u.d);
}

void omni_js_buf_set_f64(omni_dyn bd, omni_dyn at, omni_dyn v, omni_dyn le) {
  omni_js_bytes *b = want_bytes(bd, ".setFloat64");
  int64_t o = buf_at(b, at, 8, ".setFloat64");
  union { uint64_t u; double d; } u;
  u.d = want_bufnum(v, ".setFloat64");
  buf_wr8(b->p + o, u.u, omni_js_truthy(le));
}

/* TextEncoder 无状态，但 === 比的是同一性，所以还是各分一格 */
omni_dyn omni_js_text_enc_new(void) {
  uint8_t *tag = (uint8_t *)omni_alloc(1);
  *tag = 0;
  return omni_dyn_of_ref((void *)tag, OMNI_DYN_TEXTENC);
}

omni_dyn omni_js_text_encode(omni_dyn e, omni_dyn s) {
  omni_str u;
  uint8_t *p;
  if (e.tag != OMNI_DYN_TEXTENC) {
    omni_errorf(".encode expects a TextEncoder, found %s", omni_dyn_tag_name(e.tag));
  }
  u = omni_s16_to_utf8(omni_js_as_s16(s));
  p = (uint8_t *)omni_alloc((size_t)(u.len == 0 ? 1 : u.len));
  if (u.len > 0) memcpy(p, u.p, (size_t)u.len);
  return bytes_wrap(p, u.len);
}

/* WHATWG 的 utf-8 解码器状态机（encoding 规范 §6.2）。**不能**拿 omni_s16_of_utf8 顶替：
   那一份是"一个坏字节一个 U+FFFD"，与宿主在三处不齐（拿 node 量的）——
   [E4 B8] 截断我们出两个 FFFD、宿主出一个；[C0 80] 过长序列我们给 U+0000、宿主两个 FFFD；
   [ED A0 80] 代理项我们一个 FFFD、宿主三个。都是静默算错，所以照状态机重写一遍。 */
static omni_s16 text_dec_utf8(const uint8_t *p, int64_t len) {
  /* 上界：每个码元至少吃掉一个字节（4 字节序列出 2 个码元，但它占了 4 个字节），
     结尾那一个 FFFD 也落在已经吃掉、没出货的那些字节上 —— 所以 n <= len */
  uint16_t *out = (uint16_t *)omni_alloc((size_t)(len <= 0 ? 1 : len) * sizeof(uint16_t));
  int64_t n = 0, i = 0;
  uint32_t cp = 0;
  int needed = 0, seen = 0;
  unsigned lower = 0x80, upper = 0xbf;
  while (i < len) {
    unsigned b = p[i];
    if (needed == 0) {
      i++;
      seen = 0;
      if (b <= 0x7f) { out[n++] = (uint16_t)b; continue; }
      if (b >= 0xc2 && b <= 0xdf) { needed = 1; cp = b & 0x1fu; continue; }
      if (b >= 0xe0 && b <= 0xef) {
        if (b == 0xe0) lower = 0xa0;   /* 过长的三字节序列 */
        if (b == 0xed) upper = 0x9f;   /* 代理项那一段 */
        needed = 2; cp = b & 0x0fu;
        continue;
      }
      if (b >= 0xf0 && b <= 0xf4) {
        if (b == 0xf0) lower = 0x90;   /* 过长的四字节序列 */
        if (b == 0xf4) upper = 0x8f;   /* > U+10FFFF */
        needed = 3; cp = b & 0x07u;
        continue;
      }
      out[n++] = 0xfffd;               /* C0/C1、F5..FF，以及落单的续字节 */
      continue;
    }
    if (b < lower || b > upper) {
      /* 这个字节**不消费** —— 它可能是下一个序列的头（[E4 41] 要出 FFFD 再出 'A'） */
      needed = 0; seen = 0; cp = 0; lower = 0x80; upper = 0xbf;
      out[n++] = 0xfffd;
      continue;
    }
    lower = 0x80; upper = 0xbf;
    cp = (cp << 6) | (b & 0x3fu);
    seen++;
    i++;
    if (seen < needed) continue;
    if (cp <= 0xffff) {
      out[n++] = (uint16_t)cp;
    } else {
      cp -= 0x10000;
      out[n++] = (uint16_t)(0xd800 + (cp >> 10));
      out[n++] = (uint16_t)(0xdc00 + (cp & 0x3ff));
    }
    needed = 0; seen = 0; cp = 0;
  }
  if (needed != 0) out[n++] = 0xfffd;  /* 结尾截断：整段坏前缀只出一个 */
  /* 没给 ignoreBOM 时**去掉开头那一个** U+FEFF（两个 BOM 只去一个，拿 node 量过） */
  if (n > 0 && out[0] == 0xfeff) return omni_s16_of_units(out + 1, n - 1);
  return omni_s16_of_units(out, n);
}

/* 标签只认 utf-8 那一族（WHATWG encoding 的 index 里给 UTF-8 的那几个别名）。
   别的编码当场报错，不是悄悄按 utf-8 解 —— 那会把 latin1 的字节静静地译错。 */
static bool text_dec_utf8_label(omni_str s) {
  static const char *ok[] = { "utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8",
    "unicode20utf8", "x-unicode20utf8" };
  int64_t a = 0, z = s.len;
  size_t k;
  /* 规范先去掉两头的 ASCII 空白，再按大小写不敏感比 */
  while (a < z && (s.p[a] == ' ' || s.p[a] == '\t' || s.p[a] == '\n' || s.p[a] == '\r'
    || s.p[a] == '\f')) a++;
  while (z > a && (s.p[z - 1] == ' ' || s.p[z - 1] == '\t' || s.p[z - 1] == '\n'
    || s.p[z - 1] == '\r' || s.p[z - 1] == '\f')) z--;
  for (k = 0; k < sizeof(ok) / sizeof(ok[0]); k++) {
    int64_t m = (int64_t)strlen(ok[k]);
    int64_t j;
    if (z - a != m) continue;
    for (j = 0; j < m; j++) {
      char c = s.p[a + j];
      if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
      if (c != ok[k][j]) break;
    }
    if (j == m) return true;
  }
  return false;
}

/* TextDecoder 也无状态（只有 utf-8 这一档），照 TextEncoder 各分一格 */
omni_dyn omni_js_text_dec_new(omni_dyn label) {
  uint8_t *tag;
  if (label.tag != OMNI_DYN_UNDEF && label.tag != OMNI_DYN_NULL) {
    omni_str t = omni_s16_to_utf8(omni_js_as_s16(label));
    if (!text_dec_utf8_label(t)) {
      omni_errorf("new TextDecoder: only the utf-8 labels are supported, found '%.*s'",
        (int)t.len, t.p);
    }
  }
  tag = (uint8_t *)omni_alloc(1);
  *tag = 0;
  return omni_dyn_of_ref((void *)tag, OMNI_DYN_TEXTDEC);
}

omni_dyn omni_js_text_decode(omni_dyn d, omni_dyn b) {
  omni_js_bytes *v;
  if (d.tag != OMNI_DYN_TEXTDEC) {
    omni_errorf(".decode expects a TextDecoder, found %s", omni_dyn_tag_name(d.tag));
  }
  /* `dec.decode()` 是空串（缺席的实参补的是 undefined），与宿主一样 */
  if (b.tag == OMNI_DYN_UNDEF || b.tag == OMNI_DYN_NULL) {
    static const uint16_t none = 0;
    return omni_dyn_of_s16(omni_s16_of_units(&none, 0));
  }
  v = want_bytes(b, ".decode");
  return omni_dyn_of_s16(text_dec_utf8(v->p, v->len));
}


/* JS 那一族模板里的状态（ADR-0021 S1）：定义在这儿，只有一份。
   为什么不留在模板里：模板在生成的 C 里展开，插件是另一个映像，展开两遍就是两套对象模型。
   声明与那几个 #define 在 omni.h 里 —— 模板里的名字照旧，指过来的是这几格。 */
omni_dyn omni_js_realm_tbl_g[25];
omni_dyn omni_js_ctor_tbl_g[19];
omni_dyn omni_js_gt_tbl_g[1];
omni_dyn omni_js_nt_slot_g = { OMNI_DYN_UNDEF, { 0 } };
omni_dyn omni_js_this_slot_g = { OMNI_DYN_UNDEF, { 0 } };
int64_t omni_js_jobq_at_g;
void *omni_js_fnproto_tbl_g = NULL;
void *omni_js_xprops_tbl_g = NULL;
void *omni_js_frozen_tbl_g = NULL;
void *omni_js_sealed_tbl_g = NULL;
void *omni_js_noext_tbl_g = NULL;
void *omni_js_jobq_g = NULL;
void *omni_js_pm_find_g = NULL;
void *omni_js_pm_call_g = NULL;
