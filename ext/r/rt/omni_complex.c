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

/* ================ 超越那一族（`clog` / `csqrt` / `cexp` / …，第十八格）============
 *
 * R 的 `src/main/complex.c` 直接调这 13 个（`z_log` 那一套在 HAVE_* 齐的平台上就是
 * 转手给 C99），所以"链得起"要它们。写法与上面两个不同的一点：这一族**不追求与
 * 平台 libm 逐位相同** —— Apple 的 libm 与 musl 的 `clog` 本来就差最后几位。判据是
 * `tests/r/rtc.js` 第三节记死的**相对误差上界**，外加实轴/Inf/NaN 那几格的分类相同。
 *
 * 实函数（`exp`/`log`/`sin`/…）问 libm（我们的 `callLibc` 那一侧有），复数那一层的
 * 公式写在这儿：这样精度的来源只有一处，出了偏差看的是公式不是实现。
 */

double exp(double);
double log(double);
double log1p(double);
double sqrt(double);
double sin(double);
double cos(double);
double tan(double);
double sinh(double);
double cosh(double);
double tanh(double);
double asin(double);
double atan(double);
double pow(double, double);

static const double OMNI_PI_2 = 1.5707963267948966;

/** `exp(z)`：模长 `exp(x)`、相角 `y`。x 很大时 `exp(x)` 会先溢出，那时分两步缩放。 */
double _Complex cexp(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  if (y == 0.0) return cx_of(exp(x), y).z;          /* 实轴：虚部的符号要留住 */
  if (omni_isinf(x)) {
    if (x < 0.0) {
      if (!omni_isfinite(y)) y = 1.0;               /* 0 * 任意 = 0，符号不定，取正 */
      return cx_of(0.0 * cos(y), 0.0 * sin(y)).z;
    }
    if (!omni_isfinite(y)) return cx_of(x, y - y).z; /* Inf * 不定 = NaN 虚部 */
    return cx_of(x * cos(y), x * sin(y)).z;
  }
  if (omni_isnan(x)) return cx_of(x, y == 0.0 ? y : x).z;
  if (x > 709.0) {                                   /* 先取出 e^709，剩下的再乘 */
    double e = exp(x - 709.0);
    double k = 8.2184074615549e307;                  /* exp(709) */
    return cx_of(e * cos(y) * k, e * sin(y) * k).z;
  }
  double e = exp(x);
  return cx_of(e * cos(y), e * sin(y)).z;
}

/**
 * `log(z)`：实部 `log|z|`、虚部 `arg z`。`|z|` 贴着 1 的时候 `log(hypot)` 会把有效位
 * 全丢在减法里（`log(1+eps)`），那一带改走 `log1p(x*x+y*y-1)`。
 */
double _Complex clog(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  double ax = omni_fabs(x);
  double ay = omni_fabs(y);
  double mx = ax > ay ? ax : ay;
  double re;
  if (mx > 0.5 && mx < 1.5 && omni_isfinite(mx)) {
    /* x*x + y*y - 1 要精确：大的那一项拆成 (m-1)*(m+1) 免得先凑成 1 再减 */
    double mn = ax > ay ? ay : ax;
    re = 0.5 * log1p((mx - 1.0) * (mx + 1.0) + mn * mn);
  } else {
    re = log(hypot(x, y));
  }
  return cx_of(re, atan2(y, x)).z;
}

/** `sqrt(z)`：主支。`t = sqrt((|x| + |z|)/2)` 之后两支分开写，免得除以 0。 */
double _Complex csqrt(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  if (x == 0.0 && y == 0.0) return cx_of(0.0, y).z;
  if (omni_isinf(y)) return cx_of(1.0 / 0.0, y).z;
  if (omni_isnan(x)) return cx_of(x, omni_isinf(y) ? y : x).z;
  if (omni_isinf(x)) {
    if (x < 0.0) return cx_of(omni_isnan(y) ? y : 0.0, omni_copysign(x * -1.0, y)).z;
    return cx_of(x, omni_isnan(y) ? y : omni_copysign(0.0, y)).z;
  }
  double t = sqrt((omni_fabs(x) + hypot(x, y)) * 0.5);
  if (x >= 0.0) return cx_of(t, y / (t + t)).z;
  return cx_of(omni_fabs(y) / (t + t), omni_copysign(t, y)).z;
}

/** `pow(z, w) = exp(w * log z)`，乘法走 `__muldc3`（Inf/NaN 的收法只有一处）。 */
double _Complex cpow(double _Complex z, double _Complex w) {
  omni_cx a;
  omni_cx b;
  a.z = z;
  b.z = w;
  if (a.p.r == 0.0 && a.p.i == 0.0) {
    if (b.p.r == 0.0 && b.p.i == 0.0) return cx_of(1.0, 0.0).z;
    if (b.p.i == 0.0 && b.p.r > 0.0) return cx_of(0.0, 0.0).z;
  }
  /* 底是正实数、指数是实数：直接 `pow`，比绕一圈 log/exp 精确 */
  if (a.p.i == 0.0 && a.p.r > 0.0 && b.p.i == 0.0) return cx_of(pow(a.p.r, b.p.r), 0.0).z;
  omni_cx l;
  l.z = clog(z);
  omni_cx m;
  m.z = __muldc3(b.p.r, b.p.i, l.p.r, l.p.i);
  return cexp(m.z);
}

/* ---- 三角与双曲：加法公式，一条实公式一条虚公式 ------------------------------ */

double _Complex csinh(double _Complex z) {
  omni_cx c;
  c.z = z;
  return cx_of(sinh(c.p.r) * cos(c.p.i), cosh(c.p.r) * sin(c.p.i)).z;
}

double _Complex ccosh(double _Complex z) {
  omni_cx c;
  c.z = z;
  return cx_of(cosh(c.p.r) * cos(c.p.i), sinh(c.p.r) * sin(c.p.i)).z;
}

/** `tanh(x+iy) = (sinh2x + i sin2y) / (cosh2x + cos2y)`。x 大了分母溢出，那时答 ±1。 */
double _Complex ctanh(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  if (omni_fabs(x) > 350.0) return cx_of(omni_copysign(1.0, x), omni_copysign(0.0, sin(y + y))).z;
  double d = cosh(x + x) + cos(y + y);
  return cx_of(sinh(x + x) / d, sin(y + y) / d).z;
}

double _Complex csin(double _Complex z) {
  omni_cx c;
  c.z = z;
  return cx_of(sin(c.p.r) * cosh(c.p.i), cos(c.p.r) * sinh(c.p.i)).z;
}

double _Complex ccos(double _Complex z) {
  omni_cx c;
  c.z = z;
  return cx_of(cos(c.p.r) * cosh(c.p.i), -sin(c.p.r) * sinh(c.p.i)).z;
}

/** `tan(x+iy) = (sin2x + i sinh2y) / (cos2x + cosh2y)` —— 与 `ctanh` 对称的那一条。 */
double _Complex ctan(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  if (omni_fabs(y) > 350.0) return cx_of(omni_copysign(0.0, sin(x + x)), omni_copysign(1.0, y)).z;
  double d = cos(x + x) + cosh(y + y);
  return cx_of(sin(x + x) / d, sinh(y + y) / d).z;
}

/* ---- 反三角：写成 log 与 sqrt 的组合（主支照 C99 附录 G）--------------------- */

/** `asin(z) = -i log(iz + sqrt(1 - z^2))`。实轴上 |x|<=1 时直接问 `asin`，精度好得多。 */
double _Complex casin(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  if (y == 0.0 && omni_fabs(x) <= 1.0) return cx_of(asin(x), y).z;
  omni_cx z2;
  z2.z = __muldc3(x, y, x, y);
  /* |z| 很小的时候 log 那条路会把有效位全丢在 `1 - z^2` 与 `log(1+eps)` 里
     （量出来 1e-8 那格差了 5e-9），那一带走级数 `z + z^3/6`（下一项 3z^5/40
     在 |z| < 1e-4 时相对只有 1e-17）。 */
  if (omni_fabs(x) < 1e-4 && omni_fabs(y) < 1e-4) {
    omni_cx t;
    t.z = __muldc3(x, y, z2.p.r / 6.0, z2.p.i / 6.0);
    return cx_of(x + t.p.r, y + t.p.i).z;
  }
  omni_cx s;
  s.z = csqrt(cx_of(1.0 - z2.p.r, -z2.p.i).z);
  /* `iz + s` 与 `s - iz` 的**积恒为 1**（两个根相乘是 -((iz)^2 - (1-z^2)) = 1），
     所以 `log(iz+s) = -log(s-iz)`。|z| 大的时候前者两个分量都在互相抵消
     （量出来 z=100+0.5i 那格差了 2e-13），那时取后者再取负 —— 同一个值，没有抵消。 */
  double ur = s.p.r - y;
  double ui = s.p.i + x;                             /* iz = -y + xi */
  double vr = s.p.r + y;
  double vi = s.p.i - x;
  omni_cx l;
  if (hypot(ur, ui) >= hypot(vr, vi)) {
    l.z = clog(cx_of(ur, ui).z);
  } else {
    omni_cx t;
    t.z = clog(cx_of(vr, vi).z);
    l = cx_of(-t.p.r, -t.p.i);
  }
  return cx_of(l.p.i, -l.p.r).z;                     /* -i * (a+bi) = b - ai */
}

/** `acos(z) = pi/2 - asin(z)`。 */
double _Complex cacos(double _Complex z) {
  omni_cx a;
  a.z = casin(z);
  return cx_of(OMNI_PI_2 - a.p.r, -a.p.i).z;
}

/** `atan(z) = -(i/2) log((1 + iz) / (1 - iz))`，除法走 `__divdc3`。 */
double _Complex catan(double _Complex z) {
  omni_cx c;
  c.z = z;
  double x = c.p.r;
  double y = c.p.i;
  if (y == 0.0) return cx_of(atan(x), y).z;
  /* 与 `casin` 同一条缝：|z| 小的时候走级数 `z - z^3/3`。 */
  if (omni_fabs(x) < 1e-4 && omni_fabs(y) < 1e-4) {
    omni_cx z2;
    z2.z = __muldc3(x, y, x, y);
    omni_cx t;
    t.z = __muldc3(x, y, z2.p.r / 3.0, z2.p.i / 3.0);
    return cx_of(x - t.p.r, y - t.p.i).z;
  }
  omni_cx q;
  q.z = __divdc3(1.0 - y, x, 1.0 + y, -x);
  omni_cx l;
  l.z = clog(q.z);
  return cx_of(0.5 * l.p.i, -0.5 * l.p.r).z;         /* -(i/2) * (a+bi) = b/2 - a/2 i */
}
