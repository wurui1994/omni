/* `<math.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * 两处照 glibc 的事实，不是自己挑的：
 *
 *  - `isnan` / `isinf` / `isfinite` / `signbit` 在 glibc 上是宏。它先试
 *    `__builtin_isnan` 一族，编译器没有那些内建时退回**函数**（`__isnan` /
 *    `__isinf` / `__finite` / `__signbit`，`math.h` 里那段 `#else`）。我们的前端
 *    没有那几个内建（只有 `__builtin_nanf` 与 `__builtin_huge_val*`，见
 *    `tccdefs.js` 的 `COMPILE_DEFS`），所以这儿直接走函数那一路 ——
 *    量到的外部符号里正是 `__isnan` / `__finite` / `__signbit` 这几个。
 *  - `NAN` / `INFINITY` 用 `__builtin_nanf("")` 与 `__builtin_huge_valf()`：
 *    这两个内建我们有，展开成 `(0.0F/0.0F)` 与 `1e50f`。
 *
 * 函数清单是**量出来的**：运行时那 20 份 `.c` 编出来的未定义符号（见
 * `src/sysroot/README.md` 的量法），不是照 C99 抄一遍。 */
#ifndef _MATH_H
#define _MATH_H

#define NAN (__builtin_nanf(""))
#define INFINITY (__builtin_huge_valf())
#define HUGE_VAL (__builtin_huge_val())
#define HUGE_VALF (__builtin_huge_valf())

#define M_PI 3.14159265358979323846
#define M_E 2.7182818284590452354

extern int __isnan(double x);
extern int __isnanf(float x);
extern int __isinf(double x);
extern int __isinff(float x);
extern int __finite(double x);
extern int __finitef(float x);
extern int __signbit(double x);
extern int __signbitf(float x);

#define isnan(x) __isnan((double)(x))
#define isinf(x) __isinf((double)(x))
#define isfinite(x) __finite((double)(x))
#define signbit(x) __signbit((double)(x))

double acos(double x);
double acosh(double x);
double asin(double x);
double asinh(double x);
double atan(double x);
double atan2(double y, double x);
double atanh(double x);
double cbrt(double x);
double ceil(double x);
double cos(double x);
double cosh(double x);
double exp(double x);
double expm1(double x);
double fabs(double x);
double floor(double x);
double fma(double x, double y, double z);
double fmax(double x, double y);
double fmin(double x, double y);
double fmod(double x, double y);
double hypot(double x, double y);
double ldexp(double x, int e);
double log(double x);
double log10(double x);
double log1p(double x);
double log2(double x);
double nextafter(double x, double y);
double pow(double x, double y);
double round(double x);
double sin(double x);
double sinh(double x);
double sqrt(double x);
float sqrtf(float x);
double tan(double x);
double tanh(double x);
double trunc(double x);

#endif
