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
    case OMNI_DYN_INT: return v.u.i != 0;
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
    /* int 是 BigInt 的映像（ADR-0011 第 5 节），所以 typeof 是 bigint */
    case OMNI_DYN_INT: n = "bigint"; break;
    case OMNI_DYN_REAL: n = "number"; break;
    case OMNI_DYN_STR16: n = "string"; break;
    case OMNI_DYN_FN: n = "function"; break;
    default: n = "object"; break;
  }
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fmt("%s", n)));
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
    case OMNI_DYN_REAL: return omni_s16_of_utf8(js_num_str(v.u.r));
    case OMNI_DYN_STR16: return v.u.s16;
    default:
      omni_errorf("cannot convert %s to string", omni_dyn_tag_name(v.tag));
      return omni_s16_of_utf8(omni_str_new("", 0));
  }
}

omni_dyn omni_js_str(omni_dyn v) { return omni_dyn_of_s16(to_s16(v)); }

/* 输出：JS 的 String 是 UTF-16，落到 stdout 得转回 UTF-8。这个 op 存在的意义
   是让"什么时候转码"变成一处显式的边界，而不是散落在各个打印点上。 */
void omni_js_println(omni_dyn v) {
  omni_str s = omni_s16_to_utf8(to_s16(v));
  printf("%.*s\n", (int)s.len, s.p);
}

/* ---------------------------------------------------------------- 算术 */

static bool is_num(omni_dyn v) { return v.tag == OMNI_DYN_INT || v.tag == OMNI_DYN_REAL; }
static double as_f64(omni_dyn v) { return v.tag == OMNI_DYN_INT ? (double)v.u.i : v.u.r; }

static void want_num(int op, omni_dyn a, omni_dyn b) {
  if (!is_num(a) || !is_num(b)) {
    omni_errorf("cannot apply '%c' to %s and %s", op,
                omni_dyn_tag_name(a.tag), omni_dyn_tag_name(b.tag));
  }
  /* JS 里 BigInt 与 Number 混用是 TypeError；这条一定要保留，否则源码里 int/real
     混错的地方会被悄悄接受，而 JS 宿主上会抛异常 —— 两个后端就分叉了 */
  if (a.tag != b.tag) {
    omni_errorf("cannot mix bigint and number in '%c'", op);
  }
}

omni_dyn omni_js_add(omni_dyn a, omni_dyn b) {
  if (a.tag == OMNI_DYN_STR16 || b.tag == OMNI_DYN_STR16) {
    return omni_dyn_of_s16(omni_s16_cat(to_s16(a), to_s16(b)));
  }
  want_num('+', a, b);
  if (a.tag == OMNI_DYN_INT) return omni_dyn_of_int(omni_add(a.u.i, b.u.i));
  return omni_dyn_of_real(a.u.r + b.u.r);
}

omni_dyn omni_js_arith(int op, omni_dyn a, omni_dyn b) {
  want_num(op, a, b);
  if (a.tag == OMNI_DYN_INT) {
    switch (op) {
      case '-': return omni_dyn_of_int(omni_sub(a.u.i, b.u.i));
      case '*': return omni_dyn_of_int(omni_mul(a.u.i, b.u.i));
      case '/': return omni_dyn_of_int(omni_div(a.u.i, b.u.i));
      case '%': return omni_dyn_of_int(omni_mod(a.u.i, b.u.i));
      default: omni_errorf("unknown arithmetic op '%c'", op);
    }
  }
  switch (op) {
    case '-': return omni_dyn_of_real(a.u.r - b.u.r);
    case '*': return omni_dyn_of_real(a.u.r * b.u.r);
    case '/': return omni_dyn_of_real(a.u.r / b.u.r);
    case '%': return omni_dyn_of_real(fmod(a.u.r, b.u.r));
    default: omni_errorf("unknown arithmetic op '%c'", op);
  }
  return omni_dyn_null();
}

omni_dyn omni_js_neg(omni_dyn a) {
  if (a.tag == OMNI_DYN_INT) return omni_dyn_of_int(omni_neg(a.u.i));
  if (a.tag == OMNI_DYN_REAL) return omni_dyn_of_real(-a.u.r);
  omni_errorf("cannot negate %s", omni_dyn_tag_name(a.tag));
  return omni_dyn_null();
}

/* 位运算只对 int（= BigInt）成立。JS 的 Number 位运算会先截成 int32，
   编译器源码不用那条路径，所以这里直接拒绝 real —— 宁可报错也不要静默截断。 */
omni_dyn omni_js_bitop(int op, omni_dyn a, omni_dyn b) {
  if (a.tag != OMNI_DYN_INT || b.tag != OMNI_DYN_INT) {
    omni_errorf("bitwise '%c' requires bigint operands, found %s and %s", op,
                omni_dyn_tag_name(a.tag), omni_dyn_tag_name(b.tag));
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
  if (a.tag != OMNI_DYN_INT) {
    omni_errorf("bitwise '~' requires a bigint operand, found %s", omni_dyn_tag_name(a.tag));
  }
  return omni_dyn_of_int(~a.u.i);
}

/* ---------------------------------------------------------------- 比较 */

bool omni_js_cmp(int op, omni_dyn a, omni_dyn b) {
  int c;
  if (a.tag == OMNI_DYN_STR16 && b.tag == OMNI_DYN_STR16) {
    c = omni_s16_cmp(a.u.s16, b.u.s16);
  } else {
    if (!is_num(a) || !is_num(b)) {
      omni_errorf("cannot compare %s with %s", omni_dyn_tag_name(a.tag), omni_dyn_tag_name(b.tag));
    }
    double x = as_f64(a), y = as_f64(b);
    /* NaN 参与的关系比较全为假，这一条不能靠 c 的三态表达 */
    if (isnan(x) || isnan(y)) return false;
    c = x < y ? -1 : (x > y ? 1 : 0);
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
      double x = as_f64(a), y = as_f64(b);
      return x == y;
    }
  }
  if (a.tag != b.tag) return false;
  switch (a.tag) {
    case OMNI_DYN_UNDEF: case OMNI_DYN_NULL: return true;
    case OMNI_DYN_BOOL: return a.u.b == b.u.b;
    case OMNI_DYN_INT: return a.u.i == b.u.i;
    /* === 下 NaN 不等于自身、+0 等于 -0（这和 dict 键用的 SameValueZero 不同） */
    case OMNI_DYN_REAL: return a.u.r == b.u.r;
    case OMNI_DYN_STR16: return omni_s16_eq(a.u.s16, b.u.s16);
    default: return a.u.ref == b.u.ref;  /* 对象/数组/函数比同一性 */
  }
}
