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
};

int main(void) {
  int n = (int)(sizeof(xs) / sizeof(xs[0]));
  for (int i = 0; i < n; i++) {
    double x = xs[i];
    /* `~` 打头的行是「大参数的三角函数」：那一档我们**明说不比值**（没有
     * Payne-Hanek，见 math.c 里 `TWO_PI` 那一段），判据只要求有限、在值域里。 */
    const char *tg = (x > 3.5e13 || x < -3.5e13) ? "~" : "";
    printf("sqrt %d %.17g\n", i, sqrt(x));
    printf("exp %d %.17g\n", i, x > 710.0 ? 0.0 : exp(x));
    if (x > 0.0) {
      printf("log %d %.17g\n", i, log(x));
      printf("log2 %d %.17g\n", i, log2(x));
      printf("log10 %d %.17g\n", i, log10(x));
    }
    printf("%ssin %d %.17g\n", tg, i, sin(x));
    printf("%scos %d %.17g\n", tg, i, cos(x));
    printf("%stan %d %.17g\n", tg, i, tan(x));
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
