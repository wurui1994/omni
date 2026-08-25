/* JS 的 Number / Math / BigInt（ADR-0011 的 ABI 里 js_num_* / js_math_* 那一段）
 *
 * 与 backend-js/prelude.js 里的 $js_num_* / $js_math_* 逐位对应。
 *
 * 这一批里最要命的是 toPrecision 与 toString(radix)：编译器**自己**用它们把 double
 * 和字节写进生成的 C（`v.toPrecision(17)`、`b.toString(8)`），格式差一个字符，
 * 第二代和第三代产出的 C 就不一样，自举当场不成立。所以照规范写，不用 %g。
 */
#include "omni.h"

static double want_real(omni_dyn v, const char *who) {
  if (v.tag == OMNI_DYN_REAL) return v.u.r;
  if (v.tag == OMNI_DYN_INT) return (double)v.u.i;
  omni_errorf("%s expects a number, found %s", who, omni_dyn_tag_name(v.tag));
  return 0;
}

/* Number.isNaN / isFinite / isInteger 都**不**做转换：非 number 一律 false（规范如此，
   和全局的 isNaN 不是一回事）。 */
bool omni_js_num_is_nan(omni_dyn v) { return v.tag == OMNI_DYN_REAL && isnan(v.u.r); }

bool omni_js_num_is_finite(omni_dyn v) { return v.tag == OMNI_DYN_REAL && isfinite(v.u.r); }

bool omni_js_num_is_integer(omni_dyn v) {
  return v.tag == OMNI_DYN_REAL && isfinite(v.u.r) && v.u.r == trunc(v.u.r);
}

/* Number(x)：字符串按 JS 的数字文法解析（空串是 0，解析不动是 NaN），
   BigInt 转 double，bool 转 0/1，null 是 0，undefined 是 NaN。 */
omni_dyn omni_js_num_of(omni_dyn v) {
  switch (v.tag) {
    case OMNI_DYN_REAL: return v;
    case OMNI_DYN_INT: return omni_dyn_of_real((double)v.u.i);
    case OMNI_DYN_BOOL: return omni_dyn_of_real(v.u.b ? 1.0 : 0.0);
    case OMNI_DYN_NULL: return omni_dyn_of_real(0.0);
    case OMNI_DYN_UNDEF: return omni_dyn_of_real((double)NAN);
    case OMNI_DYN_STR16: {
      omni_str s = omni_s16_to_utf8(v.u.s16);
      char *c = omni_cstr(s);
      char *p = c;
      while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == '\v' || *p == '\f') p++;
      if (*p == '\0') return omni_dyn_of_real(0.0);
      char *end = NULL;
      double d = strtod(p, &end);
      while (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r' || *end == '\v' || *end == '\f') end++;
      if (*end != '\0') return omni_dyn_of_real((double)NAN);
      return omni_dyn_of_real(d);
    }
    default:
      omni_errorf("cannot convert %s to a number", omni_dyn_tag_name(v.tag));
      return omni_dyn_null();
  }
}

/* BigInt(x)：只认整数值的 number 与十进制/0x/0o/0b 字符串。JS 在小数上抛
   RangeError，这里报错 —— 两边都得拒绝，不能一边悄悄截尾。 */
omni_dyn omni_js_bigint_of(omni_dyn v) {
  if (v.tag == OMNI_DYN_INT) return v;
  if (v.tag == OMNI_DYN_BOOL) return omni_dyn_of_int(v.u.b ? 1 : 0);
  if (v.tag == OMNI_DYN_REAL) {
    if (!isfinite(v.u.r) || v.u.r != trunc(v.u.r)) {
      omni_error("cannot convert a non-integer number to a bigint");
    }
    return omni_dyn_of_int((int64_t)v.u.r);
  }
  if (v.tag == OMNI_DYN_STR16) {
    return omni_dyn_of_int(omni_int_of_string(omni_s16_to_utf8(v.u.s16)));
  }
  omni_errorf("cannot convert %s to a bigint", omni_dyn_tag_name(v.tag));
  return omni_dyn_null();
}

/* BigInt.asIntN：只支持 64 —— 源码里就只有这一个宽度，别的当场报错比悄悄算错好 */
omni_dyn omni_js_bigint_as_int_n(omni_dyn bits, omni_dyn v) {
  double n = want_real(bits, "BigInt.asIntN");
  if (n != 64.0) omni_errorf("only BigInt.asIntN(64, ..) is supported, got %g", n);
  if (v.tag != OMNI_DYN_INT) omni_errorf("BigInt.asIntN expects a bigint, found %s", omni_dyn_tag_name(v.tag));
  return v;
}

omni_dyn omni_js_math(int op, omni_dyn a, omni_dyn b) {
  double x = want_real(a, "Math");
  switch (op) {
    case 'a': return omni_dyn_of_real(fabs(x));
    case 't': return omni_dyn_of_real(trunc(x));
    case 'f': return omni_dyn_of_real(floor(x));
    case 'c': return omni_dyn_of_real(ceil(x));
    default: break;
  }
  double y = want_real(b, "Math");
  /* NaN 会传染，而且 Math.max(-0, 0) 是 0 —— 用 fmax/fmin 正好是这个语义 */
  if (op == 'M') return omni_dyn_of_real(isnan(x) || isnan(y) ? (double)NAN : fmax(x, y));
  if (op == 'm') return omni_dyn_of_real(isnan(x) || isnan(y) ? (double)NAN : fmin(x, y));
  omni_errorf("unknown Math op '%c'", op);
  return omni_dyn_null();
}

/* Number.prototype.toPrecision（ECMA-262）。编译器用 toPrecision(17) 把 double 写进
   生成的 C，所以这条的每一位都算在自举的不动点里。
   不走 %g：%g 的指数是两位（"1e-07"），而且什么时候切指数形式的界也和规范不同。 */
omni_dyn omni_js_num_to_precision(omni_dyn v, omni_dyn digits) {
  double x = want_real(v, "toPrecision");
  int p = (int)want_real(digits, "toPrecision");
  if (p < 1 || p > 100) omni_errorf("toPrecision() argument must be between 1 and 100, got %d", p);
  if (isnan(x)) return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_new("NaN", 3)));
  if (isinf(x)) {
    return omni_dyn_of_s16(omni_s16_of_utf8(
      x > 0 ? omni_str_new("Infinity", 8) : omni_str_new("-Infinity", 9)));
  }

  bool neg = x < 0;
  double a = neg ? -x : x;
  char buf[160];
  snprintf(buf, sizeof buf, "%.*e", p - 1, a);

  char m[128];
  int k = 0;
  const char *q = buf;
  for (; *q && *q != 'e' && *q != 'E'; q++) if (*q >= '0' && *q <= '9') m[k++] = *q;
  m[k] = '\0';
  int e = *q ? atoi(q + 1) : 0;
  if (a == 0.0) e = 0;

  char out[192];
  char *o = out;
  if (neg) *o++ = '-';
  if (e < -6 || e >= p) {
    *o++ = m[0];
    if (p > 1) { *o++ = '.'; memcpy(o, m + 1, (size_t)(p - 1)); o += p - 1; }
    *o++ = 'e';
    *o++ = e >= 0 ? '+' : '-';
    o += snprintf(o, 8, "%d", e >= 0 ? e : -e);
  } else if (e == p - 1) {
    memcpy(o, m, (size_t)p); o += p;
  } else if (e >= 0) {
    memcpy(o, m, (size_t)(e + 1)); o += e + 1;
    *o++ = '.';
    memcpy(o, m + e + 1, (size_t)(p - e - 1)); o += p - e - 1;
  } else {
    *o++ = '0'; *o++ = '.';
    for (int i = 0; i < -(e + 1); i++) *o++ = '0';
    memcpy(o, m, (size_t)p); o += p;
  }
  *o = '\0';
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fmt("%s", out)));
}

/* Number.prototype.toString(radix)。radix 省略或 10 时就是 js_str。
   非十进制只支持整数值：源码里只拿它印码点和字节（toString(16) / toString(8)），
   小数的非十进制表示 JS 自己都是"实现定义"的，两边模仿不到一起，所以直接报错。 */
omni_dyn omni_js_num_to_string(omni_dyn v, omni_dyn radix) {
  double x = want_real(v, "toString");
  int r = radix.tag == OMNI_DYN_UNDEF ? 10 : (int)want_real(radix, "toString");
  if (r < 2 || r > 36) omni_errorf("toString() radix must be between 2 and 36, got %d", r);
  if (r == 10) return omni_js_str(omni_dyn_of_real(x));
  if (!isfinite(x) || x != trunc(x)) {
    omni_error("toString(radix) with a non-integer value is not supported");
  }
  bool neg = x < 0;
  uint64_t n = (uint64_t)(neg ? -x : x);
  char tmp[80];
  int k = 0;
  if (n == 0) tmp[k++] = '0';
  while (n) { int d = (int)(n % (uint64_t)r); tmp[k++] = (char)(d < 10 ? '0' + d : 'a' + d - 10); n /= (uint64_t)r; }
  char out[82];
  char *o = out;
  if (neg) *o++ = '-';
  while (k) *o++ = tmp[--k];
  *o = '\0';
  return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fmt("%s", out)));
}
