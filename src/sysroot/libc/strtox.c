/* strtox.c — 数字的解析（第一百四十片）。零 syscall。
 *
 * `strtod` 是**正确舍入**的（第十格）：一串十进制就是两个大整数的商 `N / Den`，
 * 把商挪进 `[2^52, 2^53)` 再做一次长除法，商是 53 位尾数、余数决定末位。
 * 大整数在公用的 `dec.c` 里 —— 打印那一头（`stdio.c`）要的是同一件东西的反方向。
 * 这条路上**一次浮点运算都没有**。
 *
 * 上一版是「尾数攒成 u64、最后一次乘 10 的幂」。后果不止「差一个 ulp」：
 * `1.7976931348623157e308` 读成 inf、`5e-324` 读成 0，31 个样本 21 个位不同。
 * 量法与量到的数在 `tests/c/libc-strtod.js`。
 */
#include "libc.h"

static int isSpace(int c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
}
static int digitOf(int c, int base) {
  int d;
  if (c >= '0' && c <= '9') d = c - '0';
  else if (c >= 'a' && c <= 'z') d = c - 'a' + 10;
  else if (c >= 'A' && c <= 'Z') d = c - 'A' + 10;
  else return -1;
  return d < base ? d : -1;
}

/* 有符号/无符号共用的那一趟。`neg` 回给调用方自己定夺溢出该饱和到哪一头。 */
/* `*ovf` 回「攒的时候溢出过没有」。C11 7.22.1.4：溢出要**饱和**到极值并且 errno = ERANGE。
 * 溢出之后**照旧把数字吃完** —— `endptr` 得指到数字后头，不能停在半路。 */
static unsigned long long strtoBody(const char *s, char **end, int base, int *neg, int *ovf) {
  const char *p = s;
  while (isSpace((unsigned char)*p)) p++;
  *neg = 0;
  *ovf = 0;
  if (*p == '+' || *p == '-') { *neg = (*p == '-'); p++; }
  if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')
    && digitOf((unsigned char)p[2], 16) >= 0) {
    p += 2; base = 16;
  } else if (base == 0) {
    base = (p[0] == '0' && digitOf((unsigned char)p[1], 8) >= 0) ? 8 : 10;
  }
  unsigned long long v = 0;
  const char *first = p;
  unsigned long long b = (unsigned long long)base;
  while (1) {
    int d = digitOf((unsigned char)*p, base);
    if (d < 0) break;
    if (v > (~0ULL - (unsigned long long)d) / b) *ovf = 1;
    else v = v * b + (unsigned long long)d;
    p++;
  }
  if (end != (char **)0) *end = (char *)(p == first ? s : p);
  return v;
}

long long strtoll(const char *s, char **end, int base) {
  int neg = 0;
  int ovf = 0;
  unsigned long long v = strtoBody(s, end, base, &neg, &ovf);
  /* 有符号那一路还得自己看一眼范围（无符号里装得下的数，有符号里可能已经过了）。
   * 量到过：`strtol("99999999999999999999")` 回的是 7766279631452241919 —— 那是
   * 攒出来的低 64 位，而 glibc 回 LONG_MAX。 */
  if (ovf || (!neg && v > 0x7fffffffffffffffULL) || (neg && v > 0x8000000000000000ULL)) {
    __libc_errno_val = 34;                     /* ERANGE（两条腿上都是 34） */
    return neg ? (-0x7fffffffffffffffLL - 1) : 0x7fffffffffffffffLL;
  }
  return neg ? -(long long)v : (long long)v;
}
long strtol(const char *s, char **end, int base) { return (long)strtoll(s, end, base); }
unsigned long long strtoull(const char *s, char **end, int base) {
  int neg = 0;
  int ovf = 0;
  unsigned long long v = strtoBody(s, end, base, &neg, &ovf);
  if (ovf) { __libc_errno_val = 34; return ~0ULL; }        /* ERANGE + ULLONG_MAX */
  /* 负号在无符号那一路是**合法的**（C11 7.22.1.4：按模 2^64 取反），
   * 所以 `strtoul("-1")` 回的是 ULONG_MAX —— 与 glibc 一样。 */
  return neg ? (unsigned long long)(-(long long)v) : v;
}
unsigned long strtoul(const char *s, char **end, int base) {
  return (unsigned long)strtoull(s, end, base);
}
int atoi(const char *s) { return (int)strtoll(s, (char **)0, 10); }
long atol(const char *s) { return (long)strtoll(s, (char **)0, 10); }
long long atoll(const char *s) { return strtoll(s, (char **)0, 10); }

/* ---- `strtod` 的算术那一半：**正确舍入**，一次浮点运算都没有（第一百四十片第十格）。
 *
 * 一串十进制文字就是两个大整数的商：`值 = D × 10^dexp`，也就是
 *   dexp ≥ 0：N = D·10^dexp、Den = 1
 *   dexp < 0：N = D、Den = 10^-dexp
 * 要的是「离 N/Den 最近的 double」。办法是把商挪进 `[2^52, 2^53)` 再做**一次长除法**：
 * 商就是 53 位尾数，余数决定末位怎么收（半到偶）。大整数在公用的 `dec.c` 里 ——
 * 与打印那一头同一份。
 *
 * 上一版是「尾数攒成 u64，最后一次乘 10 的幂」。量到的后果不是「差一个 ulp」这么轻：
 * `1.7976931348623157e308` 读成 **inf**（中间那次乘法自己就溢了）、`5e-324` 读成 **0**、
 * 31 个样本里 21 个位模式与系统 libc 不同、21 个往返里 8 个回不来。 */
static double decBits(int neg, unsigned long long q, int e2, int fr) {
  /* q 是截断出来的 53 位（2^52 ≤ q < 2^53），值 = (q + 余数) · 2^e2；
   * `fr` 说余数在哪一档：0 = 正好是 0、1 = 不到半、2 = 正好半、3 = 过半。
   *
   * **收位只许收一次**：先收成 53 位再为非规格化右移，那是**两次舍入** ——
   * 量到过 `2.2250738585072011e-308`（就是 glibc 那个著名样本）读成了最小的规格化数
   * 0x0010000000000000，而正确答案是最大的非规格化数 0x000fffffffffffff。 */
  union { double d; unsigned long long u; } r;
  int E = e2 + 1075;
  unsigned long long bits;
  if (E > 0) {
    if (fr == 3 || (fr == 2 && (q & 1) != 0)) {
      q++;
      if (q == (1ULL << 53)) { q >>= 1; E++; }
    }
    if (E >= 2047) bits = 0x7ff0000000000000ULL;              /* ±inf */
    else bits = ((unsigned long long)E << 52) | (q & ((1ULL << 52) - 1));
  } else {
    /* 非规格化：直接在**该收的那一位**上收（丢掉的低位 + `fr` 一起判）。 */
    int shift = 1 - E;
    if (shift >= 54) bits = 0;                                /* 连最小的都够不着 */
    else {
      unsigned long long lost = q & ((1ULL << shift) - 1);
      unsigned long long half = 1ULL << (shift - 1);
      q >>= shift;
      int up = 0;
      if (lost > half) up = 1;
      /* 正好一半：余数不为零就过半，否则半到偶。`lost < half` 那一支不用看余数 ——
       * 它比半少至少一个单位，再加上不到一个单位的余数也过不去。 */
      else if (lost == half) up = fr != 0 ? 1 : (int)(q & 1);
      if (up) q++;
      bits = q;                  /* 进位到 2^52 正好就是最小的规格化数 */
    }
  }
  r.u = bits | (neg ? (1ULL << 63) : 0ULL);
  return r.d;
}
/* `dig`/`ndig` 是有效数字（不带前导零），值 = 那串数字 × 10^dexp；
 * `sticky` 说后面还截掉过非零位（那时精确值比这串数字**大一点点**，收末位时算作过半）。 */
static double decToDouble(const char *dig, int ndig, int dexp, int sticky, int neg) {
  if (ndig == 0) return decBits(neg, 0, -1075, 0);         /* 全是零 */
  /* 先掐掉离谱的两头，免得大整数白涨（double 的范围是 4.9e-324 … 1.8e308）。 */
  int e10 = ndig + dexp;
  if (e10 > 320) return decBits(neg, 1ULL << 52, 3000, 0); /* 一定溢出 -> ±inf */
  if (e10 < -350) return decBits(neg, 0, -1075, 0);        /* 一定下溢 -> ±0 */

  __libc_dec N;
  __libc_dec Den;
  __libc_dec S;
  __libc_dec R;
  /* N = 那串数字，九位一节地吃。 */
  __libc_dec_set(&N, 0);
  int i = 0;
  while (i < ndig) {
    unsigned int chunk = 0;
    int k = 0;
    while (k < 9 && i < ndig) { chunk = chunk * 10 + (unsigned int)(dig[i] - '0'); i++; k++; }
    __libc_dec_pow10(&N, k);
    __libc_dec_add(&N, chunk);
  }
  __libc_dec_set(&Den, 1);
  if (dexp >= 0) __libc_dec_pow10(&N, dexp);
  else __libc_dec_pow10(&Den, -dexp);
  /* 把商挪进 [2^52, 2^53)：S = Den·2^(52+t)，要的是 S ≤ N < 2S。
   * 每一步都是「乘 2 / 除 2」—— 一次浮点运算都没有，而且步数有上界（指数最多 ±1100）。 */
  __libc_dec_copy(&S, &Den);
  __libc_dec_pow2(&S, 52);
  int e2 = 0;
  int guard = 0;
  while (__libc_dec_cmp(&N, &S) < 0 && guard < 4200) { __libc_dec_mul(&N, 2); e2--; guard++; }
  for (; guard < 4200; guard++) {
    __libc_dec_mul(&S, 2);
    if (__libc_dec_cmp(&N, &S) >= 0) e2++;
    else { __libc_dec_div(&S, 2); break; }
  }
  /* 一次长除法：53 位商 + 余数。S 每步减半，出循环时正好是 Den·2^t。 */
  unsigned long long q = 0;
  __libc_dec_copy(&R, &N);
  for (int b = 52; b >= 0; b--) {
    q <<= 1;
    if (__libc_dec_cmp(&R, &S) >= 0) { __libc_dec_sub(&R, &S); q |= 1; }
    if (b > 0) __libc_dec_div(&S, 2);
  }
  /* 余数在哪一档（收位交给 `decBits` —— 那儿只收一次）：
   * 0 = 正好是 0、1 = 不到半、2 = 正好半、3 = 过半。截过位（sticky）就往上抬一档。 */
  __libc_dec_mul(&R, 2);
  int c = __libc_dec_cmp(&R, &S);
  int fr;
  if (__libc_dec_zero(&R)) fr = 0;
  else if (c < 0) fr = 1;
  else if (c == 0) fr = 2;
  else fr = 3;
  if (sticky) { if (fr == 0) fr = 1; else if (fr == 2) fr = 3; }
  return decBits(neg, q, e2, fr);
}

double strtod(const char *s, char **end) {
  const char *p = s;
  while (isSpace((unsigned char)*p)) p++;
  int neg = 0;
  if (*p == '+' || *p == '-') { neg = (*p == '-'); p++; }
  /* `inf` / `nan`（`%g` 印得出来，就得读得回来）。 */
  if ((p[0] == 'i' || p[0] == 'I') && (p[1] == 'n' || p[1] == 'N')
    && (p[2] == 'f' || p[2] == 'F')) {
    if (end != (char **)0) *end = (char *)(p + 3);
    double big = 1e308;
    return neg ? -big * 10.0 : big * 10.0;      /* 溢出成 ±inf */
  }
  if ((p[0] == 'n' || p[0] == 'N') && (p[1] == 'a' || p[1] == 'A')
    && (p[2] == 'n' || p[2] == 'N')) {
    if (end != (char **)0) *end = (char *)(p + 3);
    double z = 0.0;
    return z / z;
  }
  /* 把整个数字序列（去掉小数点）收成一串有效数字：
   *   值 = 那串数字 × 10^(截掉的位数 - 小数点后的位数 + 指数)
   * 前导零直接丢（不影响值），末尾装不下的位记进 `sticky`（780 位远超正确舍入要的
   * 767 位，所以那一格只在「有人写了八百多位」时才动）。 */
  char dig[780];
  const int CAP = 780;
  int ndig = 0;
  int dropped = 0;
  int fracCount = 0;
  int sticky = 0;
  int any = 0;
  int exp10 = 0;
  while (*p >= '0' && *p <= '9') {
    if (ndig == 0 && *p == '0') { /* 前导零：丢 */ }
    else if (ndig < CAP) dig[ndig++] = *p;
    else { dropped++; if (*p != '0') sticky = 1; }
    any = 1;
    p++;
  }
  if (*p == '.') {
    p++;
    while (*p >= '0' && *p <= '9') {
      fracCount++;
      if (ndig == 0 && *p == '0') { /* 0.000… 那几个零：只算位置，不进数字串 */ }
      else if (ndig < CAP) dig[ndig++] = *p;
      else { dropped++; if (*p != '0') sticky = 1; }
      any = 1;
      p++;
    }
  }
  if (!any) { if (end != (char **)0) *end = (char *)s; return 0.0; }
  if (*p == 'e' || *p == 'E') {
    const char *q = p + 1;
    int eneg = 0;
    if (*q == '+' || *q == '-') { eneg = (*q == '-'); q++; }
    if (*q >= '0' && *q <= '9') {
      int ev = 0;
      while (*q >= '0' && *q <= '9') {
        if (ev < 100000) ev = ev * 10 + (*q - '0');
        q++;
      }
      exp10 += eneg ? -ev : ev;
      p = q;
    }
  }
  if (end != (char **)0) *end = (char *)p;
  return decToDouble(dig, ndig, dropped - fracCount + exp10, sticky, neg);
}

double atof(const char *s) { return strtod(s, (char **)0); }
float strtof(const char *s, char **end) { return (float)strtod(s, end); }
