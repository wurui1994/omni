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
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fmt("%s", n)));
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
    case OMNI_DYN_SYM: n = "symbol"; break;
    default: n = "function"; break;
  }
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fmt("%s", n)));
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

/* JS 域里的字符串一律是 str16（ADR-0011 第 8 节）。UTF-8 的 omni_str 只在
   转码的两个出入口出现，所以这里把 to_s16 收成一个内部函数，op 层只见 str16。 */
static omni_s16 to_s16(omni_dyn v) {
  switch (v.tag) {
    case OMNI_DYN_UNDEF: return omni_s16_of_utf8(omni_str_new("undefined", 9));
    case OMNI_DYN_NULL: return omni_s16_of_utf8(omni_str_new("null", 4));
    case OMNI_DYN_BOOL: return omni_s16_of_utf8(omni_str_bool(v.u.b));
    case OMNI_DYN_INT: return omni_s16_of_utf8(omni_str_int(v.u.i));
    /* UINT 那一格印的是**无符号**的十进制：JS 那边它是一个真的大 BigInt */
    case OMNI_DYN_UINT:
      return omni_s16_of_utf8(omni_str_fmt("%llu", (unsigned long long)omni_dyn_u64(v)));
    case OMNI_DYN_REAL: return omni_s16_of_utf8(js_num_str(v.u.r));
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
    default:
      omni_errorf("cannot convert %s to string", omni_dyn_tag_name(v.tag));
      return omni_s16_of_utf8(omni_str_new("", 0));
  }
}

omni_dyn omni_js_str(omni_dyn v) { return omni_dyn_of_s16(to_s16(v)); }

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
static omni_dyn to_num1(omni_dyn v) {
  if (is_int(v) || v.tag == OMNI_DYN_REAL) return v;
  return omni_js_num_of(v);
}

omni_dyn omni_js_add(omni_dyn a, omni_dyn b) {
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

