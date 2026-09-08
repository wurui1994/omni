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
  if (v.tag == OMNI_DYN_UINT) return (double)omni_dyn_u64(v);
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
    case OMNI_DYN_UINT: return omni_dyn_of_real((double)omni_dyn_u64(v));
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

/* parseInt(s, radix)：和 Number(s) 不是一回事 —— 它吃前缀、后面有垃圾也不报错。
   量过的用法只有 parseInt(hex, 16) 两处（词法器里解 \x / \u 转义），但照规范写全：
   跳前导空白、认符号、radix 16 时允许 0x 前缀、一个合法数字都没有就是 NaN。 */
omni_dyn omni_js_num_parse_int(omni_dyn sd, omni_dyn radixd) {
  omni_str s = omni_s16_to_utf8(omni_js_as_s16(sd));
  int radix = 10;
  if (radixd.tag == OMNI_DYN_REAL && !isnan(radixd.u.r) && radixd.u.r != 0) {
    radix = (int)radixd.u.r;
    if (radix < 2 || radix > 36) return omni_dyn_of_real((double)NAN);
  } else if (radixd.tag != OMNI_DYN_UNDEF && radixd.tag != OMNI_DYN_REAL) {
    omni_errorf("parseInt radix must be a number, found %s", omni_dyn_tag_name(radixd.tag));
  }
  const char *p = omni_cstr(s);
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == '\v' || *p == '\f') p++;
  double sign = 1;
  if (*p == '+' || *p == '-') { if (*p == '-') sign = -1; p++; }
  if ((radix == 16 || radixd.tag == OMNI_DYN_UNDEF) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
    radix = 16;
    p += 2;
  }
  double acc = 0;
  int digits = 0;
  for (; *p; p++) {
    int d;
    if (*p >= '0' && *p <= '9') d = *p - '0';
    else if (*p >= 'a' && *p <= 'z') d = *p - 'a' + 10;
    else if (*p >= 'A' && *p <= 'Z') d = *p - 'A' + 10;
    else break;
    if (d >= radix) break;
    acc = acc * radix + d;
    digits++;
  }
  if (digits == 0) return omni_dyn_of_real((double)NAN);
  return omni_dyn_of_real(sign * acc);
}

/* parseFloat(s)：吃最长的合法前缀，后面有垃圾也不报错，一个数字都没有就是 NaN。
   刻意**不**把整串交给 strtod：strtod 认 "0x10"（16）、"inf"、"nan" 这些扩展，而
   JS 的 parseFloat 只认十进制字面量加 Infinity —— 所以先手划出合法前缀，再让
   strtod 只看那一段（十进制的舍入还是交给它，两边才逐位相同）。 */
omni_dyn omni_js_num_parse_float(omni_dyn sd) {
  omni_str s = omni_s16_to_utf8(omni_js_as_s16(sd));
  const char *p = omni_cstr(s);
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == '\v' || *p == '\f') p++;
  const char *start = p;
  double sign = 1;
  if (*p == '+' || *p == '-') { if (*p == '-') sign = -1; p++; }
  if (strncmp(p, "Infinity", 8) == 0) return omni_dyn_of_real(sign * (double)INFINITY);
  int digits = 0;
  while (*p >= '0' && *p <= '9') { p++; digits++; }
  if (*p == '.') {
    p++;
    while (*p >= '0' && *p <= '9') { p++; digits++; }
  }
  if (digits == 0) return omni_dyn_of_real((double)NAN);
  if (*p == 'e' || *p == 'E') {
    const char *q = p + 1;
    if (*q == '+' || *q == '-') q++;
    if (*q >= '0' && *q <= '9') {
      while (*q >= '0' && *q <= '9') q++;
      p = q;
    }
  }
  int64_t n = p - start;
  char *buf = omni_alloc_bytes(n + 1);
  memcpy(buf, start, (size_t)n);
  buf[n] = '\0';
  return omni_dyn_of_real(strtod(buf, NULL));
}

/* JS 的 StringToBigInt。刻意**不**走 omni_int_of_string：那是 Omni 的 int(string)
   语义（只认十进制），而 BigInt("0xf0") 在 JS 里是 240n —— 编译器自己的 js 词法器
   就靠它读十六进制的 bigint 字面量。收的范围是 [INT64_MIN, UINT64_MAX]：正的那半
   超过 INT64_MAX 就落到无符号那一格（决策 19），因为 jancy 的 `0xffffffffffffffff`
   要能读出来；再往外报错。 */
static omni_dyn js_str_to_int(omni_str s) {
  int64_t i = 0, n = s.len;
  while (i < n && (s.p[i] == ' ' || s.p[i] == '\t' || s.p[i] == '\n' || s.p[i] == '\r')) i++;
  while (n > i && (s.p[n - 1] == ' ' || s.p[n - 1] == '\t' || s.p[n - 1] == '\n' || s.p[n - 1] == '\r')) n--;
  bool neg = false;
  int base = 10;
  if (i < n && (s.p[i] == '+' || s.p[i] == '-')) {
    neg = s.p[i] == '-';
    i++;
  } else if (i + 1 < n && s.p[i] == '0') {
    char k = s.p[i + 1];
    if (k == 'x' || k == 'X') { base = 16; i += 2; }
    else if (k == 'o' || k == 'O') { base = 8; i += 2; }
    else if (k == 'b' || k == 'B') { base = 2; i += 2; }
  }
  uint64_t acc = 0;
  int64_t digits = 0;
  for (; i < n; i++, digits++) {
    char c = s.p[i];
    int d = 99;
    if (c >= '0' && c <= '9') d = c - '0';
    else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
    if (d >= base) omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
    if (acc > (UINT64_MAX - (uint64_t)d) / (uint64_t)base) {
      omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
    }
    acc = acc * (uint64_t)base + (uint64_t)d;
    /* 负的那半只到 INT64_MIN（|acc| <= 2^63）；正的那半到 UINT64_MAX，上面那个
       乘加的溢出检查已经把它卡住了 */
    if (neg && acc > (uint64_t)INT64_MAX + 1u) {
      omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
    }
  }
  if (digits == 0) omni_errorf("invalid integer: \"%.*s\"", (int)s.len, s.p);
  if (neg) return omni_dyn_of_int(acc == (uint64_t)INT64_MAX + 1u ? INT64_MIN : -(int64_t)acc);
  return omni_dyn_of_uint64(acc);
}

/* BigInt(x)：只认整数值的 number 与十进制/0x/0o/0b 字符串。JS 在小数上抛
   RangeError，这里报错 —— 两边都得拒绝，不能一边悄悄截尾。 */
omni_dyn omni_js_bigint_of(omni_dyn v) {
  if (v.tag == OMNI_DYN_INT || v.tag == OMNI_DYN_UINT) return v;
  if (v.tag == OMNI_DYN_BOOL) return omni_dyn_of_int(v.u.b ? 1 : 0);
  if (v.tag == OMNI_DYN_REAL) {
    if (!isfinite(v.u.r) || v.u.r != trunc(v.u.r)) {
      omni_error("cannot convert a non-integer number to a bigint");
    }
    return omni_dyn_of_int((int64_t)v.u.r);
  }
  if (v.tag == OMNI_DYN_STR16) {
    return js_str_to_int(omni_s16_to_utf8(v.u.s16));
  }
  omni_errorf("cannot convert %s to a bigint", omni_dyn_tag_name(v.tag));
  return omni_dyn_null();
}

/* BigInt.asIntN / BigInt.asUintN。宽度收 0..64：这个值域里的 int 是 int64
   （ADR-0005），宽度超过 64 的结果装不下，当场报错比悄悄算错好。
   asUintN 的结果落在 [2^63, 2^64) 时同样装不进 int64_t —— 那一半用 OMNI_DYN_UINT
   这个标签（omni_dyn_of_uint64 负责规范化：装得下的一律还是 INT）。
   两个函数的错误文本必须与 prelude 的 $js_bigint_as_*_n 逐字相同。 */
static int64_t want_bits(omni_dyn bits, const char *who) {
  double n = want_real(bits, who);
  if (!(n >= 0 && n <= 64 && n == trunc(n))) {
    omni_errorf("%s: width must be an integer in 0..64, got %g", who, n);
  }
  return (int64_t)n;
}

static uint64_t want_int_bits(omni_dyn v, const char *who) {
  if (v.tag != OMNI_DYN_INT && v.tag != OMNI_DYN_UINT) {
    omni_errorf("%s expects a bigint, found %s", who, omni_dyn_tag_name(v.tag));
  }
  return (uint64_t)v.u.i;
}

omni_dyn omni_js_bigint_as_int_n(omni_dyn bits, omni_dyn v) {
  int64_t w = want_bits(bits, "BigInt.asIntN");
  uint64_t x = want_int_bits(v, "BigInt.asIntN");
  if (w == 0) return omni_dyn_of_int(0);
  if (w == 64) return omni_dyn_of_int((int64_t)x);
  x &= (~(uint64_t)0) >> (64 - w);
  /* 低 w 位的最高位是 1 就把上面全填 1（符号扩展），这与 asIntN 的定义一致 */
  if (x & ((uint64_t)1 << (w - 1))) x |= ~(((uint64_t)1 << w) - 1);
  return omni_dyn_of_int((int64_t)x);
}

omni_dyn omni_js_bigint_as_uint_n(omni_dyn bits, omni_dyn v) {
  int64_t w = want_bits(bits, "BigInt.asUintN");
  uint64_t x = want_int_bits(v, "BigInt.asUintN");
  if (w == 0) return omni_dyn_of_int(0);
  if (w == 64) return omni_dyn_of_uint64(x);
  return omni_dyn_of_uint64(x & ((~(uint64_t)0) >> (64 - w)));
}

omni_dyn omni_js_math(int op, omni_dyn a, omni_dyn b) {
  double x = want_real(a, "Math");
  switch (op) {
    case 'a': return omni_dyn_of_real(fabs(x));
    case 't': return omni_dyn_of_real(trunc(x));
    case 'f': return omni_dyn_of_real(floor(x));
    case 'c': return omni_dyn_of_real(ceil(x));
    case 's': return omni_dyn_of_real(sqrt(x));
    /* C 的 round 就是"离零舍入"；prelude 那边为此没用 Math.round（它向 +inf 舍入） */
    case 'r': return omni_dyn_of_real(round(x));
    /* 超越函数：转手 libm（JS 那边转手 Math.*）。op 码见 hir/js_abi.js 的注释 */
    case 'S': return omni_dyn_of_real(sin(x));
    case 'C': return omni_dyn_of_real(cos(x));
    case 'T': return omni_dyn_of_real(tan(x));
    case 'I': return omni_dyn_of_real(asin(x));
    case 'A': return omni_dyn_of_real(acos(x));
    case 'N': return omni_dyn_of_real(atan(x));
    case 'H': return omni_dyn_of_real(sinh(x));
    case 'D': return omni_dyn_of_real(cosh(x));
    case 'G': return omni_dyn_of_real(tanh(x));
    case 'J': return omni_dyn_of_real(asinh(x));
    case 'K': return omni_dyn_of_real(acosh(x));
    case 'L': return omni_dyn_of_real(atanh(x));
    case 'E': return omni_dyn_of_real(exp(x));
    case 'X': return omni_dyn_of_real(expm1(x));
    case 'O': return omni_dyn_of_real(log(x));
    case 'Q': return omni_dyn_of_real(log10(x));
    case 'P': return omni_dyn_of_real(log1p(x));
    case 'B': return omni_dyn_of_real(cbrt(x));
    /* fround（ADR-0017 第一刀）：把一个 double 舍到最近的 float 再读回来。
       C 这边就是一次 (float) 强制转换 —— 唯一要小心的是编译器不许把它优化掉，
       所以中间量显式落在一个 float 变量上。MIR 的 f32 语义（每步之后舍一次）靠它。 */
    case 'F': {
      float f = (float)x;
      return omni_dyn_of_real((double)f);
    }
    /* clz32：ToUint32 之后数前导零。不用 __builtin_clz —— 它在 0 上是未定义的，
       而 Math.clz32(0) 必须是 32。 */
    case 'Z': {
      uint32_t u = 0;
      if (isfinite(x)) {
        double t = fmod(trunc(x), 4294967296.0);
        if (t < 0) t += 4294967296.0;
        u = (uint32_t)t;
      }
      int n = 0;
      if (u == 0) {
        n = 32;
      } else {
        while (!(u & 0x80000000u)) { u <<= 1; n++; }
      }
      return omni_dyn_of_real((double)n);
    }
    default: break;
  }
  double y = want_real(b, "Math");
  /* NaN 会传染，而且 Math.max(-0, 0) 是 0 —— 用 fmax/fmin 正好是这个语义 */
  if (op == 'M') return omni_dyn_of_real(isnan(x) || isnan(y) ? (double)NAN : fmax(x, y));
  if (op == 'm') return omni_dyn_of_real(isnan(x) || isnan(y) ? (double)NAN : fmin(x, y));
  if (op == 'p') return omni_dyn_of_real(pow(x, y));
  if (op == 'o') return omni_dyn_of_real(fmod(x, y));
  if (op == '2') return omni_dyn_of_real(atan2(x, y));
  if (op == 'Y') return omni_dyn_of_real(hypot(x, y));
  /* nextafter（ADR-0019 路 2）：`Math.*` 里没有它，所以 prelude 那边是**手写**的
     （把 f64 的位模式当 i64 加减一）。这一条是权威，那一份要与它逐字节对上。 */
  if (op == 'W') return omni_dyn_of_real(nextafter(x, y));
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
  int r = radix.tag == OMNI_DYN_UNDEF ? 10 : (int)want_real(radix, "toString");
  if (r < 2 || r > 36) omni_errorf("toString() radix must be between 2 and 36, got %d", r);
  /* 接收者也可能是 int（这个值域里的 bigint）或 bool。int 不先转 double：2^53 之上的
     int64 转过去要掉精度，所以按 64 位整数自己走那个取余的循环。 */
  if (v.tag == OMNI_DYN_BOOL) return omni_js_str(v);
  if (v.tag == OMNI_DYN_INT || v.tag == OMNI_DYN_UINT) {
    if (r == 10) return omni_js_str(v);
    bool ineg = v.tag == OMNI_DYN_INT && v.u.i < 0;
    /* uint 那一格（决策 19）与 int 共用 u.i，按无符号重新解释就是它的值 */
    uint64_t un = v.tag == OMNI_DYN_UINT ? (uint64_t)v.u.i
      : (ineg ? (uint64_t)(-(v.u.i + 1)) + 1u : (uint64_t)v.u.i);
    char itmp[80];
    int ik = 0;
    if (un == 0) itmp[ik++] = '0';
    while (un) {
      int d = (int)(un % (uint64_t)r);
      itmp[ik++] = (char)(d < 10 ? '0' + d : 'a' + d - 10);
      un /= (uint64_t)r;
    }
    char iout[82];
    char *io = iout;
    if (ineg) *io++ = '-';
    while (ik) *io++ = itmp[--ik];
    *io = '\0';
    return omni_dyn_of_s16(omni_s16_of_utf8(omni_str_fmt("%s", iout)));
  }
  double x = want_real(v, "toString");
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
