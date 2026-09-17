/* math.c — 我们自己那份 libm（第一百四十片）。
 *
 * 目标不是「和 glibc 逐位相同」，是**几个 ulp 之内**、而且每一格都说得清用的是哪个
 * 恒等式。量法与量到的最大相对误差记在 `tests/x64/docker-run.sh` 的第 10 笔账上。
 *
 * 路数（都是教科书那几条，刻意不用查表的多项式拟合 —— 那种表抄进来就是「复制别人的
 * 常数」，而这一份要能自己解释每一个数字）：
 *   exp   :  x = n·ln2 + r，|r| ≤ ln2/2，r 上泰勒 13 项，再 ldexp(·, n)
 *   log   :  x = m·2^k，m ∈ [1,2)，log m = 2·atanh((m-1)/(m+1)) 的级数 + k·ln2
 *   sin/cos: 先 mod 2π（Cody-Waite 两段 π 常数），再八分之一圈上的泰勒
 *   atan  :  |x|>1 换 1/x，>0.5 再用加法公式往下压，剩下的级数
 *   sqrt  :  指数减半当初值，三次牛顿
 *   pow   :  整数指数走平方法（精确得多），否则 exp(y·log x)
 */
#include "libc.h"

/* 位模式那一格。C 里读 double 的位只有 union 这一条合法路子（严格别名）。 */
typedef union { double d; unsigned long long u; } DBits;

#define PI      3.14159265358979311600
#define PI_2    1.57079632679489655800
#define LN2     0.69314718055994530942
#define LN2_HI  0.69314718036912381649   /* ln2 的高 32 位，低位在 LN2_LO */
#define LN2_LO  1.90821492927058770002e-10
#define LN10    2.30258509299404568402
#define INV_LN2 1.44269504088896338700

int __isnan(double x) { return x != x; }
int isnan(double x) { return x != x; }
int __isinf(double x) {
  DBits b; b.d = x;
  return (b.u & 0x7fffffffffffffffULL) == 0x7ff0000000000000ULL;
}
int isinf(double x) { return __isinf(x); }
int __finite(double x) {
  DBits b; b.d = x;
  return (b.u & 0x7ff0000000000000ULL) != 0x7ff0000000000000ULL;
}
int finite(double x) { return __finite(x); }
int __signbit(double x) { DBits b; b.d = x; return (int)(b.u >> 63); }
int signbit(double x) { return __signbit(x); }

double fabs(double x) { DBits b; b.d = x; b.u &= 0x7fffffffffffffffULL; return b.d; }
float fabsf(float x) { return x < 0.0f ? -x : x; }
double copysign(double x, double y) {
  DBits a; DBits b;
  a.d = x; b.d = y;
  a.u = (a.u & 0x7fffffffffffffffULL) | (b.u & 0x8000000000000000ULL);
  return a.d;
}
double fmax(double a, double b) { return a != a ? b : (b != b ? a : (a > b ? a : b)); }
double fmin(double a, double b) { return a != a ? b : (b != b ? a : (a < b ? a : b)); }

/* ---- 取整那一族。|x| < 2^52 时小数位还在，直接靠「加 2^52 再减」把它抹掉
 * （这是浮点取整的老办法：加上 2^52 之后最低位的权重就是 1，小数位被舍入吃掉）。
 * ≥ 2^52 的 double 本来就是整数，原样回。 */
static double roundToward(double x, int mode) {   /* 0 = trunc, 1 = floor, 2 = ceil */
  DBits b; b.d = x;
  int e = (int)((b.u >> 52) & 0x7ff) - 1023;
  if (e >= 52) return x;                      /* 已经是整数（含 inf/nan） */
  if (e < 0) {                                /* |x| < 1 */
    if (x == 0.0) return x;
    if (mode == 0) return x > 0 ? 0.0 : -0.0;
    if (mode == 1) return x > 0 ? 0.0 : -1.0;
    return x > 0 ? 1.0 : -0.0;
  }
  double big = 4503599627370496.0;            /* 2^52 */
  double t = x > 0 ? (x + big) - big : (x - big) + big;
  if (mode == 0) {                            /* trunc：往零 */
    if (x > 0 && t > x) t -= 1.0;
    if (x < 0 && t < x) t += 1.0;
  } else if (mode == 1) {                     /* floor */
    if (t > x) t -= 1.0;
  } else {                                    /* ceil */
    if (t < x) t += 1.0;
  }
  return t;
}
double trunc(double x) { return roundToward(x, 0); }
double floor(double x) { return roundToward(x, 1); }
double ceil(double x) { return roundToward(x, 2); }
/* `round`：离零那一头（C11 的 round 不是「取偶」）。 */
double round(double x) {
  double t = trunc(x);
  double f = x - t;
  if (f >= 0.5) return t + 1.0;
  if (f <= -0.5) return t - 1.0;
  return t;
}
double rint(double x) {                        /* 取偶（IEEE 默认那一种） */
  double big = 4503599627370496.0;
  if (fabs(x) >= big) return x;
  return x > 0 ? (x + big) - big : (x - big) + big;
}
double nearbyint(double x) { return rint(x); }

/* `ldexp`：直接动指数位。溢出/下溢交给硬件（乘一个 2 的幂）。 */
double ldexp(double x, int n) {
  if (x == 0.0 || !__finite(x)) return x;
  /* 分两步乘，避开「2^n 本身就溢出/下溢」那一档。 */
  while (n > 1000) { x *= 8.98846567431158e307; n -= 1023; }
  while (n < -1000) { x *= 1.1125369292536007e-308; n += 1022; }
  DBits b;
  b.u = ((unsigned long long)(n + 1023) & 0x7ffULL) << 52;
  return x * b.d;
}
double scalbn(double x, int n) { return ldexp(x, n); }

/* ---- sqrt：指数减半当初值，牛顿迭代（每次翻倍有效位）。
 *
 * 两格都是量出来才对的：
 *   - 初值的指数要按 **floor** 减半。C 的 `/` 是往零截，`-1/2` 得 0 —— 于是 x = 0.5
 *     的初值成了 2^0·√2 = 1.414（真值 0.707），起手相对误差 0.7。
 *   - 从那个初值起 4 次牛顿只到 4.6e-8（量到的就是这个数：120 个采样点里最大的
 *     那一格是 `sqrt(0.5)`）。牛顿每次翻倍有效位，0.7 -> 0.25 -> 0.017 -> 2.4e-4
 *     -> 4.6e-8 -> 1.5e-15 -> 收敛，所以要 6 次。 */
double sqrt(double x) {
  if (x != x || x < 0.0) { double z = 0.0; return x == 0.0 ? x : z / z; }   /* nan */
  if (x == 0.0 || !__finite(x)) return x;
  DBits b; b.d = x;
  int e = (int)((b.u >> 52) & 0x7ff) - 1023;
  int half = e >= 0 ? e / 2 : -((-e + 1) / 2);        /* floor(e/2) */
  DBits g;
  g.u = ((unsigned long long)(half + 1023) & 0x7ffULL) << 52;
  double r = g.d;
  if (e - 2 * half != 0) r *= 1.4142135623730951;     /* e 是奇数 */
  r = 0.5 * (r + x / r);
  r = 0.5 * (r + x / r);
  r = 0.5 * (r + x / r);
  r = 0.5 * (r + x / r);
  r = 0.5 * (r + x / r);
  r = 0.5 * (r + x / r);
  return r;
}
float sqrtf(float x) { return (float)sqrt((double)x); }

/* `fmod`：位精确的老办法 —— 把 y 按 2 的幂抬到与 x 同一档，逐档减。
 * 不用 `x - trunc(x/y)*y`：商大的时候那个 trunc 早就没有有效位了。 */
double fmod(double x, double y) {
  if (y == 0.0 || x != x || y != y || !__finite(x)) { double z = 0.0; return z / z; }
  if (!__finite(y)) return x;
  int neg = x < 0.0;
  x = fabs(x);
  y = fabs(y);
  if (x < y) return neg ? -x : x;
  DBits bx; DBits by;
  bx.d = x; by.d = y;
  int ex = (int)((bx.u >> 52) & 0x7ff);
  int ey = (int)((by.u >> 52) & 0x7ff);
  double yy = ldexp(y, ex - ey);
  int k = ex - ey;
  while (k >= 0) {
    if (x >= yy) x -= yy;
    yy *= 0.5;
    k--;
  }
  return neg ? -x : x;
}

/* ---- exp：x = n·ln2 + r，|r| ≤ ln2/2，r 上泰勒。
 * ln2 拆成高低两段（Cody-Waite）：`x - n*LN2` 直接算会在 n 大的时候把 r 的有效位吃掉。 */
double exp(double x) {
  if (x != x) return x;
  if (x > 709.782712893384) { DBits b; b.u = 0x7ff0000000000000ULL; return b.d; }
  if (x < -745.1332191019411) return 0.0;
  double nd = rint(x * INV_LN2);
  int n = (int)nd;
  double r = (x - nd * LN2_HI) - nd * LN2_LO;
  /* e^r，|r| ≤ 0.347：13 项之后余项 < 2^-60。霍纳法从高次往回收。 */
  double s = 1.0 / 87178291200.0;               /* 1/14! 的位置从 13 次起 */
  s = 1.0 / 6227020800.0 + r * s;               /* 1/13! */
  s = 1.0 / 479001600.0 + r * s;                /* 1/12! */
  s = 1.0 / 39916800.0 + r * s;
  s = 1.0 / 3628800.0 + r * s;
  s = 1.0 / 362880.0 + r * s;
  s = 1.0 / 40320.0 + r * s;
  s = 1.0 / 5040.0 + r * s;
  s = 1.0 / 720.0 + r * s;
  s = 1.0 / 120.0 + r * s;
  s = 1.0 / 24.0 + r * s;
  s = 1.0 / 6.0 + r * s;
  s = 0.5 + r * s;
  s = 1.0 + r * s;
  s = 1.0 + r * s;
  return ldexp(s, n);
}

/* ---- log：x = m·2^k，m ∈ [√2/2, √2)，log m = 2·atanh(t)，t = (m-1)/(m+1)。
 * 把 m 收进 [0.707, 1.414) 之后 |t| < 0.1716，级数 8 项余项 < 2^-56。 */
double log(double x) {
  if (x != x || x < 0.0) { double z = 0.0; return x < 0.0 ? z / z : x; }
  if (x == 0.0) { DBits b; b.u = 0xfff0000000000000ULL; return b.d; }   /* -inf */
  if (!__finite(x)) return x;
  DBits b; b.d = x;
  int k = (int)((b.u >> 52) & 0x7ff) - 1023;
  b.u = (b.u & 0x000fffffffffffffULL) | 0x3ff0000000000000ULL;          /* m ∈ [1,2) */
  double m = b.d;
  if (m > 1.4142135623730951) { m *= 0.5; k++; }
  double t = (m - 1.0) / (m + 1.0);
  double t2 = t * t;
  double s = 1.0 / 17.0;
  s = 1.0 / 15.0 + t2 * s;
  s = 1.0 / 13.0 + t2 * s;
  s = 1.0 / 11.0 + t2 * s;
  s = 1.0 / 9.0 + t2 * s;
  s = 1.0 / 7.0 + t2 * s;
  s = 1.0 / 5.0 + t2 * s;
  s = 1.0 / 3.0 + t2 * s;
  s = 1.0 + t2 * s;
  return 2.0 * t * s + (double)k * LN2_HI + (double)k * LN2_LO;
}

double log2(double x) { return log(x) * INV_LN2; }
double log10(double x) { return log(x) / LN10; }
/* `log1p`/`expm1`：小参数上**不能**走 `log(1+x)` / `exp(x)-1`（那两步把有效位全抵掉了），
 * 所以 |x| 小的时候直接上级数。 */
double log1p(double x) {
  if (fabs(x) > 0.0625) return log(1.0 + x);
  double s = 1.0 / 11.0;
  s = -1.0 / 10.0 + x * s;
  s = 1.0 / 9.0 + x * s;
  s = -1.0 / 8.0 + x * s;
  s = 1.0 / 7.0 + x * s;
  s = -1.0 / 6.0 + x * s;
  s = 1.0 / 5.0 + x * s;
  s = -1.0 / 4.0 + x * s;
  s = 1.0 / 3.0 + x * s;
  s = -0.5 + x * s;
  s = 1.0 + x * s;
  return x * s;
}
double expm1(double x) {
  if (fabs(x) > 0.0625) return exp(x) - 1.0;
  double s = 1.0 / 5040.0;
  s = 1.0 / 720.0 + x * s;
  s = 1.0 / 120.0 + x * s;
  s = 1.0 / 24.0 + x * s;
  s = 1.0 / 6.0 + x * s;
  s = 0.5 + x * s;
  s = 1.0 + x * s;
  return x * s;
}

/* `pow`：整数指数走平方法（精确得多，而且 `pow(-2, 3)` 那一档 log 根本不成立），
 * 否则 exp(y·log x)。特例照 C11 7.12.7.4。 */
double pow(double x, double y) {
  if (y == 0.0) return 1.0;
  if (x != x || y != y) { double z = 0.0; return z / z; }
  if (y == 1.0) return x;
  if (y == 2.0) return x * x;
  if (y == 0.5) return sqrt(x);
  double yi = trunc(y);
  if (yi == y && fabs(y) <= 1024.0) {
    long long n = (long long)yi;
    int neg = n < 0;
    if (neg) n = -n;
    double r = 1.0;
    double b = x;
    while (n > 0) {
      if (n & 1) r *= b;
      b *= b;
      n >>= 1;
    }
    return neg ? 1.0 / r : r;
  }
  if (x < 0.0) { double z = 0.0; return z / z; }     /* 负底数 + 非整数指数：nan */
  if (x == 0.0) return y > 0.0 ? 0.0 : 1.0 / x;
  return exp(y * log(x));
}
/* ---- sin/cos：先把 x 折进 [-π/4, π/4] 加一个象限号，再各自的泰勒。
 * π/2 拆**三段**（Cody-Waite，fdlibm 的 pio2_1 / pio2_2 / pio2_2t）：两段在
 * `tan(π/2)` 那种「离极点只差 6e-17」的地方还不够 —— 量到过相对误差 5.75e-11
 * （tan 在极点附近把折叠误差放大 1e16 倍）。三段之后折出来的 r 有 ~1e-33 的余量。 */
#define PIO2_HI 1.57079632673412561417
#define PIO2_LO 6.07710050630396597660e-11
#define PIO2_LO2 2.02226624879595063154e-21
/* 2π 的 double：**大参数**先按它折一次。`fmod` 是精确运算，所以这一步不引入任何误差 ——
 * 但 2π 自己与真值差 2.4e-17，于是 |x| 很大时折出来的相对位置**不是**真的那一个。
 * 这一格明说：我们没有 Payne-Hanek（那要几百位的 2/π），所以 |x| > 2^45 时回的是
 * 「把 2π 当成它的 double 值」那个世界里的答案 —— 有限、在值域里、可重复，但与
 * glibc/Apple 不同（它们真做了）。判据 `tests/c/libc-libm.js` 把这一档单列。 */
#define TWO_PI 6.283185307179586477

static double sinCore(double x) {          /* |x| ≤ π/4 */
  /* 泰勒到 x^17。**13! 与 15! 那两项不能跳**：上一版这儿写的是 1/17! 与 1/18!
   * （注释还说「已在噪声以下」），实际上跳掉的是 +1/13! 与 -1/15! ——
   * x = 0.707 那一档 x^13/13! ≈ 8.9e-13，量到 `sin(0.7071067811865476)` 与 Apple
   * 的 libm 差 **2.7e-12**（而同一个点上 cos 只差 1.4e-16，cosCore 的链是全的）。
   * 阶乘：13! = 6227020800、15! = 1307674368000、17! = 355687428096000。 */
  double x2 = x * x;
  double s = 1.0 / 355687428096000.0;      /* +1/17! */
  s = -1.0 / 1307674368000.0 + x2 * s;     /* -1/15! */
  s = 1.0 / 6227020800.0 + x2 * s;         /* +1/13! */
  s = -1.0 / 39916800.0 + x2 * s;          /* -1/11! */
  s = 1.0 / 362880.0 + x2 * s;             /* +1/9! */
  s = -1.0 / 5040.0 + x2 * s;              /* -1/7! */
  s = 1.0 / 120.0 + x2 * s;                /* +1/5! */
  s = -1.0 / 6.0 + x2 * s;                 /* -1/3! */
  return x + x * x2 * s;
}
static double cosCore(double x) {          /* |x| ≤ π/4 */
  double x2 = x * x;
  double s = -1.0 / 87178291200.0;         /* 1/14! */
  s = 1.0 / 479001600.0 + x2 * s;          /* 1/12! */
  s = -1.0 / 3628800.0 + x2 * s;           /* 1/10! */
  s = 1.0 / 40320.0 + x2 * s;              /* 1/8! */
  s = -1.0 / 720.0 + x2 * s;               /* 1/6! */
  s = 1.0 / 24.0 + x2 * s;                 /* 1/4! */
  s = -0.5 + x2 * s;                       /* 1/2! */
  return 1.0 + x2 * s;
}

/* 折叠：回象限号 q（mod 4），把折完的 r 写回 `*rp`。 */
static int foldPi2(double x, double *rp) {
  /* 大参数：先按 2π 的 double 折一次（`fmod` 精确，不引入误差；理由见上面那一段）。
   * 少了这一步 `nd * PIO2_HI` 那个乘积会大到 1e300，减完剩下的 r 也是 1e300 ——
   * 量到过 `sin(1e300)` 回 **inf**（`sinCore` 里 x² 溢出）。 */
  if (x > 3.5e13 || x < -3.5e13) x = fmod(x, TWO_PI);
  double nd = rint(x * (2.0 / PI));
  double r = ((x - nd * PIO2_HI) - nd * PIO2_LO) - nd * PIO2_LO2;
  *rp = r;
  double q = fmod(nd, 4.0);
  int qi = (int)q;
  if (qi < 0) qi += 4;
  return qi;
}

double sin(double x) {
  if (x != x || !__finite(x)) { double z = 0.0; return z / z; }
  double r;
  int q = foldPi2(x, &r);
  if (q == 0) return sinCore(r);
  if (q == 1) return cosCore(r);
  if (q == 2) return -sinCore(r);
  return -cosCore(r);
}
double cos(double x) {
  if (x != x || !__finite(x)) { double z = 0.0; return z / z; }
  double r;
  int q = foldPi2(x, &r);
  if (q == 0) return cosCore(r);
  if (q == 1) return -sinCore(r);
  if (q == 2) return -cosCore(r);
  return sinCore(r);
}
double tan(double x) { return sin(x) / cos(x); }
/* ---- atan：|x| > 1 换成 π/2 - atan(1/x)，然后**半角三次**把 x 压到 0.1 以下再上级数。
 *
 * 半角用的是 atan(x) = 2·atan( x / (1 + √(1+x²)) )。为什么不是加法公式那一版：
 * 第一版写的是「> 0.5 就用 atan(0.5) + atanCore((x-0.5)/(1+x/2))」，而 x = 1 那一档
 * 压完还有 0.333 —— 级数在 0.2679 之外就不够了。量到的后果是 `atan(0.5)` 与 glibc
 * 差 **1.8e-7**（120 个采样点里最大的那一格），因为 0.5 直接进了级数。
 * 半角这一版每次把 x 压到不到一半，x ≤ 1 时三次就到 0.0985，余项 < 2^-63。 */
static double atanCore(double x) {         /* |x| ≤ 0.1 */
  double x2 = x * x;
  double s = 1.0 / 17.0;
  s = -1.0 / 15.0 + x2 * s;
  s = 1.0 / 13.0 + x2 * s;
  s = -1.0 / 11.0 + x2 * s;
  s = 1.0 / 9.0 + x2 * s;
  s = -1.0 / 7.0 + x2 * s;
  s = 1.0 / 5.0 + x2 * s;
  s = -1.0 / 3.0 + x2 * s;
  s = 1.0 + x2 * s;
  return x * s;
}
double atan(double x) {
  if (x != x) return x;
  int neg = x < 0.0;
  x = fabs(x);
  double r;
  if (!__finite(x)) r = PI_2;
  else {
    int inv = 0;
    if (x > 1.0) { x = 1.0 / x; inv = 1; }
    int h = 0;
    while (x > 0.1 && h < 4) { x = x / (1.0 + sqrt(1.0 + x * x)); h++; }
    r = atanCore(x);
    while (h > 0) { r *= 2.0; h--; }
    if (inv) r = PI_2 - r;
  }
  return neg ? -r : r;
}
double atan2(double y, double x) {
  if (x != x || y != y) { double z = 0.0; return z / z; }
  if (x == 0.0 && y == 0.0) return __signbit(x) ? (__signbit(y) ? -PI : PI) : (__signbit(y) ? -0.0 : 0.0);
  if (x == 0.0) return y > 0.0 ? PI_2 : -PI_2;
  double a = atan(y / x);
  if (x > 0.0) return a;
  return y >= 0.0 ? a + PI : a - PI;
}
double asin(double x) {
  if (x != x) return x;
  if (x > 1.0 || x < -1.0) { double z = 0.0; return z / z; }
  if (x == 1.0) return PI_2;
  if (x == -1.0) return -PI_2;
  return atan(x / sqrt(1.0 - x * x));
}
double acos(double x) {
  if (x != x) return x;
  if (x > 1.0 || x < -1.0) { double z = 0.0; return z / z; }
  return PI_2 - asin(x);
}
/* ---- 双曲那六个：全靠 exp / log 的恒等式。
 * `tanh` 大参数上要夹住（exp(2x) 会溢出），`sinh` 小参数上走 expm1（不然抵消）。 */
double sinh(double x) {
  if (fabs(x) < 0.5) { double t = expm1(x); return 0.5 * (t + t / (t + 1.0)); }
  double e = exp(x);
  return 0.5 * (e - 1.0 / e);
}
double cosh(double x) {
  double e = exp(fabs(x));
  return 0.5 * (e + 1.0 / e);
}
double tanh(double x) {
  if (x != x) return x;
  double a = fabs(x);
  if (a > 20.0) return x > 0.0 ? 1.0 : -1.0;      /* 再往上 double 分不出 1 了 */
  double t = expm1(-2.0 * a);
  double r = -t / (t + 2.0);
  return x < 0.0 ? -r : r;
}
double asinh(double x) {
  double a = fabs(x);
  double r = log1p(a + a * a / (1.0 + sqrt(1.0 + a * a)));
  return x < 0.0 ? -r : r;
}
double acosh(double x) {
  if (x < 1.0) { double z = 0.0; return z / z; }
  return log(x + sqrt(x * x - 1.0));
}
double atanh(double x) {
  if (x > 1.0 || x < -1.0) { double z = 0.0; return z / z; }
  return 0.5 * log1p(2.0 * x / (1.0 - x));
}

/* ---- 剩下那几个 */
double cbrt(double x) {
  if (x == 0.0 || !__finite(x)) return x;
  int neg = x < 0.0;
  double a = fabs(x);
  double r = exp(log(a) / 3.0);
  /* 两次牛顿把 exp/log 那两步的误差压回去：r ← r - (r³ - a)/(3r²) */
  r = r - (r * r * r - a) / (3.0 * r * r);
  r = r - (r * r * r - a) / (3.0 * r * r);
  return neg ? -r : r;
}
/* `hypot`：先按大的那个缩放，免得 x² 自己就溢出/下溢。 */
double hypot(double x, double y) {
  x = fabs(x); y = fabs(y);
  if (x < y) { double t = x; x = y; y = t; }
  if (x == 0.0) return 0.0;
  double r = y / x;
  return x * sqrt(1.0 + r * r);
}
/* **不是**真的融合乘加（那要 80 位或 `vfmadd`）：这一格是 `x*y + z` 两步。
 * 明写在这儿 —— 靠 fma 抹掉中间舍入的算法在这份 libc 上不成立。 */
double fma(double x, double y, double z) { return x * y + z; }
double nextafter(double x, double y) {
  if (x != x || y != y) { double z = 0.0; return z / z; }
  if (x == y) return y;
  DBits b; b.d = x;
  if (x == 0.0) { b.u = 1; return y > 0.0 ? b.d : -b.d; }
  if ((y > x) == (x > 0.0)) b.u++; else b.u--;
  return b.d;
}
double modf(double x, double *ip) {
  double t = trunc(x);
  *ip = t;
  return x - t;
}
double frexp(double x, int *ep) {
  if (x == 0.0 || !__finite(x)) { *ep = 0; return x; }
  DBits b; b.d = x;
  int e = (int)((b.u >> 52) & 0x7ff) - 1022;
  b.u = (b.u & 0x800fffffffffffffULL) | 0x3fe0000000000000ULL;
  *ep = e;
  return b.d;
}
