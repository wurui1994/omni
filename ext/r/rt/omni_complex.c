/* ext/r/rt/omni_complex.c —— C99 复数那一族，**我们自己用 C 写**（ADR-0047 的下一刀第 2 半）。
 *
 * 为什么要这一份：R 的复数运算就是 C99 的运算符（`src/main/complex.c` 的 TIMESOP/DIVOP
 * 写的是 `toC99(&a) * toC99(&b)`），而 clang 把复数的 `*` / `/` 发成对 `__muldc3` /
 * `__divdc3` 的调用 —— 那两个里头有 Smith 算法与 Inf 回收。前端手写朴素公式在 Inf/NaN
 * 上与它不一样，那是**静默答错的边角**，所以那两个函数由这一份提供。
 *
 * 这一份**不需要复数算术就能编**：分量靠一个 union 取
 * （`union { double _Complex z; struct { double r, i; } p; }`）—— 于是它只用到
 * "`_Complex` 有多大"（第十三格已经落了）、struct 按值传/回、成员访问三件事。
 *
 * 算法照 compiler-rt（`lib/builtins/muldc3.c` / `divdc3.c`）—— 参考是别人的实现，
 * 不是我们的复述：那两份是 clang 真正链进去的东西，而"与 cc 逐字节相同"是这条腿的判据。
 */

typedef union { double _Complex z; struct { double r, i; } p; } omni_cx;

/* 分量出入口：把一个复数拆成两个 double、把两个 double 装回一个复数。 */
static omni_cx cx_of(double re, double im) {
  omni_cx c;
  c.p.r = re;
  c.p.i = im;
  return c;
}

double creal(double _Complex z) { omni_cx c; c.z = z; return c.p.r; }
double cimag(double _Complex z) { omni_cx c; c.z = z; return c.p.i; }

double _Complex conj(double _Complex z) {
  omni_cx c;
  c.z = z;
  return cx_of(c.p.r, -c.p.i).z;
}

double hypot(double, double);
double atan2(double, double);

/* 这几格**自己写**，不问 libm：`isnan`/`isinf`/`isfinite` 在真 C 里是宏
   （展开成 `__inline_isnand` 那一族），按函数声明两边都链不上；`copysign` 要的是
   **符号位**，所以走一个 64 位整数的 union；`scalbn` 只在除法里缩放，乘 2 的幂是精确的。 */
typedef union { double d; unsigned long long u; } omni_bits;

static int omni_isnan(double x) { return x != x; }
static int omni_isinf(double x) {
  omni_bits b;
  b.d = x;
  return (b.u & 0x7fffffffffffffffULL) == 0x7ff0000000000000ULL;
}
static int omni_isfinite(double x) { return !omni_isnan(x) && !omni_isinf(x); }
static double omni_fabs(double x) {
  omni_bits b;
  b.d = x;
  b.u = b.u & 0x7fffffffffffffffULL;
  return b.d;
}
static double omni_copysign(double x, double y) {
  omni_bits a;
  omni_bits b;
  a.d = x;
  b.d = y;
  a.u = (a.u & 0x7fffffffffffffffULL) | (b.u & 0x8000000000000000ULL);
  return a.d;
}
static double omni_scalbn(double x, int n) {
  double r = x;
  int k = n;
  while (k > 0) { r = r * 2.0; k = k - 1; }
  while (k < 0) { r = r * 0.5; k = k + 1; }
  return r;
}

double cabs(double _Complex z) { omni_cx c; c.z = z; return hypot(c.p.r, c.p.i); }
double carg(double _Complex z) { omni_cx c; c.z = z; return atan2(c.p.i, c.p.r); }

/**
 * 复数乘（compiler-rt 的 `__muldc3`）。朴素式算完之后那一段**回收**是关键：
 * 两个分量都是 NaN 时按"哪一边是无穷、哪一边是 NaN"把符号补回去 ——
 * `(Inf+0i) * (2+0i)` 于是是 `Inf+0i` 而不是 `NaN+NaNi`。
 */
double _Complex __muldc3(double a, double b, double c, double d) {
  double ac = a * c;
  double bd = b * d;
  double ad = a * d;
  double bc = b * c;
  double re = ac - bd;
  double im = ad + bc;
  if (omni_isnan(re) && omni_isnan(im)) {
    int recalc = 0;
    if (omni_isinf(a) || omni_isinf(b)) {
      a = omni_copysign(omni_isinf(a) ? 1.0 : 0.0, a);
      b = omni_copysign(omni_isinf(b) ? 1.0 : 0.0, b);
      if (omni_isnan(c)) c = omni_copysign(0.0, c);
      if (omni_isnan(d)) d = omni_copysign(0.0, d);
      recalc = 1;
    }
    if (omni_isinf(c) || omni_isinf(d)) {
      c = omni_copysign(omni_isinf(c) ? 1.0 : 0.0, c);
      d = omni_copysign(omni_isinf(d) ? 1.0 : 0.0, d);
      if (omni_isnan(a)) a = omni_copysign(0.0, a);
      if (omni_isnan(b)) b = omni_copysign(0.0, b);
      recalc = 1;
    }
    if (!recalc && (omni_isinf(ac) || omni_isinf(bd) || omni_isinf(ad) || omni_isinf(bc))) {
      if (omni_isnan(a)) a = omni_copysign(0.0, a);
      if (omni_isnan(b)) b = omni_copysign(0.0, b);
      if (omni_isnan(c)) c = omni_copysign(0.0, c);
      if (omni_isnan(d)) d = omni_copysign(0.0, d);
      recalc = 1;
    }
    if (recalc) {
      double inf = 1.0 / 0.0;
      re = inf * (a * c - b * d);
      im = inf * (a * d + b * c);
    }
  }
  return cx_of(re, im).z;
}

/**
 * 复数除（compiler-rt 的 `__divdc3`）：Smith 算法（按 |c| 与 |d| 谁大分两支，
 * 免得 `c*c + d*d` 先溢出），外加同一套 Inf/NaN 回收。
 */
double _Complex __divdc3(double a, double b, double c, double d) {
  int ilogbw = 0;
  double logbw = 0.0;
  double cc = omni_fabs(c);
  double dd = omni_fabs(d);
  double mx = cc > dd ? cc : dd;
  if (omni_isfinite(mx)) {
    /* `logb` 那一步照 compiler-rt：把两个分母分量缩到 1 附近再算，避免中间溢出。
       这儿用整数指数的近似（`scalbn` 的逆）—— 只要两侧同缩同放，结果不变。 */
    while (mx >= 2.0) { mx = mx * 0.5; ilogbw = ilogbw + 1; }
    while (mx > 0.0 && mx < 1.0) { mx = mx * 2.0; ilogbw = ilogbw - 1; }
    logbw = (double)ilogbw;
    c = omni_scalbn(c, -ilogbw);
    d = omni_scalbn(d, -ilogbw);
  }
  double denom = c * c + d * d;
  double re = omni_scalbn((a * c + b * d) / denom, -ilogbw);
  double im = omni_scalbn((b * c - a * d) / denom, -ilogbw);
  if (omni_isnan(re) && omni_isnan(im)) {
    double inf = 1.0 / 0.0;
    if (denom == 0.0 && (!omni_isnan(a) || !omni_isnan(b))) {
      re = omni_copysign(inf, c) * a;
      im = omni_copysign(inf, c) * b;
    } else if ((omni_isinf(a) || omni_isinf(b)) && omni_isfinite(c) && omni_isfinite(d)) {
      a = omni_copysign(omni_isinf(a) ? 1.0 : 0.0, a);
      b = omni_copysign(omni_isinf(b) ? 1.0 : 0.0, b);
      re = inf * (a * c + b * d);
      im = inf * (b * c - a * d);
    } else if (omni_isinf(mx) && omni_isfinite(a) && omni_isfinite(b)) {
      c = omni_copysign(omni_isinf(c) ? 1.0 : 0.0, c);
      d = omni_copysign(omni_isinf(d) ? 1.0 : 0.0, d);
      re = 0.0 * (a * c + b * d);
      im = 0.0 * (b * c - a * d);
    }
  }
  (void)logbw;
  return cx_of(re, im).z;
}
