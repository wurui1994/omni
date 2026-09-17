/* strtox.c — 数字的解析（第一百四十片）。零 syscall。
 *
 * `strtod` 的形状：整数位与小数位攒成一个 `unsigned long long` 的尾数、
 * 十进制指数单独记，最后一次 `尾数 * 10^exp`。这样只有**一次**乘除的误差 ——
 * 边攒边乘（`v = v * 10 + d` 之后再 `/ 10`）每一位都掉精度，量到过差好几个 ulp。
 * 10 的幂用一张表 + 平方法，不用 `pow`（这一份不许依赖 math.c）。
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
static unsigned long long strtoBody(const char *s, char **end, int base, int *neg) {
  const char *p = s;
  while (isSpace((unsigned char)*p)) p++;
  *neg = 0;
  if (*p == '+' || *p == '-') { *neg = (*p == '-'); p++; }
  if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')
    && digitOf((unsigned char)p[2], 16) >= 0) {
    p += 2; base = 16;
  } else if (base == 0) {
    base = (p[0] == '0' && digitOf((unsigned char)p[1], 8) >= 0) ? 8 : 10;
  }
  unsigned long long v = 0;
  const char *first = p;
  while (1) {
    int d = digitOf((unsigned char)*p, base);
    if (d < 0) break;
    v = v * (unsigned long long)base + (unsigned long long)d;
    p++;
  }
  if (end != (char **)0) *end = (char *)(p == first ? s : p);
  return v;
}

long long strtoll(const char *s, char **end, int base) {
  int neg = 0;
  unsigned long long v = strtoBody(s, end, base, &neg);
  return neg ? -(long long)v : (long long)v;
}
long strtol(const char *s, char **end, int base) { return (long)strtoll(s, end, base); }
unsigned long long strtoull(const char *s, char **end, int base) {
  int neg = 0;
  unsigned long long v = strtoBody(s, end, base, &neg);
  return neg ? (unsigned long long)(-(long long)v) : v;
}
unsigned long strtoul(const char *s, char **end, int base) {
  return (unsigned long)strtoull(s, end, base);
}
int atoi(const char *s) { return (int)strtoll(s, (char **)0, 10); }
long atol(const char *s) { return (long)strtoll(s, (char **)0, 10); }
long long atoll(const char *s) { return strtoll(s, (char **)0, 10); }

/* 10 的整数次幂，平方法（表里 0..22 是精确的 —— double 装得下 10^22）。 */
static const double POW10[23] = {
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22
};

static double pow10i(int e) {
  int neg = e < 0;
  if (neg) e = -e;
  double r = 1.0;
  double b = 10.0;
  /* 小的那一档直接查表（精确，没有累积误差）。 */
  if (e <= 22) r = POW10[e];
  else {
    while (e > 0) {
      if (e & 1) r *= b;
      b *= b;
      e >>= 1;
    }
  }
  return neg ? 1.0 / r : r;
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
  unsigned long long mant = 0;
  int exp10 = 0;
  int any = 0;
  int nd = 0;
  while (*p >= '0' && *p <= '9') {
    if (nd < 19) { mant = mant * 10 + (unsigned long long)(*p - '0'); nd++; }
    else exp10++;                     /* 尾数装满了：后面的位只抬指数 */
    any = 1;
    p++;
  }
  if (*p == '.') {
    p++;
    while (*p >= '0' && *p <= '9') {
      if (nd < 19) { mant = mant * 10 + (unsigned long long)(*p - '0'); nd++; exp10--; }
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
  double v = (double)mant;
  /* **一次**乘除（见文件头）：10^exp10 先算好再乘。 */
  v = exp10 >= 0 ? v * pow10i(exp10) : v / pow10i(-exp10);
  return neg ? -v : v;
}

double atof(const char *s) { return strtod(s, (char **)0); }
float strtof(const char *s, char **end) { return (float)strtod(s, end); }
