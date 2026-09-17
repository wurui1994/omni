/* `<math.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 与 Linux 那一份差的就是**判据函数的名字**：macOS 的 `<math.h>` 在
 * `_DONT_USE_CTYPE_INLINE_` 那一路把 `isnan` 一族展开成 `__isnand` / `__isinfd` /
 * `__isfinited` / `__signbitd`（量到的外部符号里正是 `___isnand` 这一串 ——
 * Mach-O 的名字再前面加一条下划线）。 */
#ifndef _MATH_H
#define _MATH_H

#define NAN (__builtin_nanf(""))
#define INFINITY (__builtin_huge_valf())
#define HUGE_VAL (__builtin_huge_val())
#define HUGE_VALF (__builtin_huge_valf())

#define M_PI 3.14159265358979323846
#define M_E 2.7182818284590452354

extern int __isnand(double x);
extern int __isnanf(float x);
extern int __isinfd(double x);
extern int __isinff(float x);
extern int __isfinited(double x);
extern int __isfinitef(float x);
extern int __signbitd(double x);
extern int __signbitf(float x);

#define isnan(x) __isnand((double)(x))
#define isinf(x) __isinfd((double)(x))
#define isfinite(x) __isfinited((double)(x))
#define signbit(x) __signbitd((double)(x))

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
