/* 自带 libm 与平台 libm 的逐点对账。
 *
 * 印的是 `%.17g`（打印那一头已经精确了，所以这一份量的**只是 libm 自己的误差**）。
 * 判据 `tests/c/libc-libm.js` 把两边的数读回来算相对误差 —— 记「最大相对误差」这个数，
 * 只许变小。挑的点都在各自的难处：过零点（`cos(π/2)` 附近）、边界（`asin(1)`）、
 * 大小两头（`exp(700)`、`log(1e-300)`）、以及归约要转好几圈的地方（`sin(1e6)`）。
 */
int printf(const char *, ...);
double sqrt(double);
double exp(double);
double log(double);
double log2(double);
double log10(double);
double sin(double);
double cos(double);
double tan(double);
double asin(double);
double acos(double);
double atan(double);
double atan2(double, double);
double pow(double, double);
double fmod(double, double);
double hypot(double, double);
double sinh(double);
double cosh(double);
double tanh(double);
double floor(double);
double ceil(double);
double fabs(double);

static const double xs[] = {
  0.0, 1e-8, 0.1, 0.25, 0.5, 0.7071067811865476, 1.0, 1.5707963267948966,
  2.0, 3.141592653589793, 10.0, 100.0, 1e6, 1e-300, 1e300, 700.0, 0.9999999999,
  /* 大参数：折叠靠 Payne-Hanek（几百位的 π）。1e18 与 1e40 都在 2^45 之上。 */
  1e18, 1e40, 123456789012345678.0,
};

int main(void) {
  int n = (int)(sizeof(xs) / sizeof(xs[0]));
  for (int i = 0; i < n; i++) {
    double x = xs[i];
    printf("sqrt %d %.17g\n", i, sqrt(x));
    printf("exp %d %.17g\n", i, x > 710.0 ? 0.0 : exp(x));
    if (x > 0.0) {
      printf("log %d %.17g\n", i, log(x));
      printf("log2 %d %.17g\n", i, log2(x));
      printf("log10 %d %.17g\n", i, log10(x));
    }
    printf("sin %d %.17g\n", i, sin(x));
    printf("cos %d %.17g\n", i, cos(x));
    printf("tan %d %.17g\n", i, tan(x));
    if (x <= 1.0) {
      printf("asin %d %.17g\n", i, asin(x));
      printf("acos %d %.17g\n", i, acos(x));
    }
    printf("atan %d %.17g\n", i, atan(x));
    printf("atan2 %d %.17g\n", i, atan2(x, 2.0));
    printf("pow %d %.17g\n", i, pow(x, 0.375));
    printf("fmod %d %.17g\n", i, fmod(x, 3.0));
    printf("hypot %d %.17g\n", i, hypot(x, 1.0));
    printf("sinh %d %.17g\n", i, x > 700.0 ? 0.0 : sinh(x));
    printf("cosh %d %.17g\n", i, x > 700.0 ? 0.0 : cosh(x));
    printf("tanh %d %.17g\n", i, tanh(x));
    printf("floor %d %.17g\n", i, floor(x + 0.5));
    printf("ceil %d %.17g\n", i, ceil(x + 0.5));
    printf("fabs %d %.17g\n", i, fabs(-x));
  }
  return 0;
}
