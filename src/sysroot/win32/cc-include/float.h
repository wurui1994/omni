/* float.h —— 只给 `--cc msvc` 这条腿用的那一份（第 msvc 刀）。
 *
 * 与 stddef.h 同一个原因：MSVC 把 freestanding 的这几个头放在 **UCRT** 里，而 UCRT 一进来
 * 就会把 time_t/size_t 一族按它的说法重定义，跟我们这套 sysroot 冲突。量到的是
 *   omni_r3.c(46): fatal error C1083: Cannot open include file: 'float.h'
 *
 * 值按 IEEE-754（x64 与 arm64 上 double 都是 64 位、long double 与 double 同宽）。
 */
#ifndef __OMNI_MSVC_FLOAT_H
#define __OMNI_MSVC_FLOAT_H

#define FLT_RADIX 2

#define FLT_MANT_DIG 24
#define FLT_DIG 6
#define FLT_MIN_EXP (-125)
#define FLT_MAX_EXP 128
#define FLT_MIN 1.175494351e-38F
#define FLT_MAX 3.402823466e+38F
#define FLT_EPSILON 1.192092896e-07F

#define DBL_MANT_DIG 53
#define DBL_DIG 15
#define DBL_MIN_EXP (-1021)
#define DBL_MAX_EXP 1024
#define DBL_MIN 2.2250738585072014e-308
#define DBL_MAX 1.7976931348623158e+308
#define DBL_EPSILON 2.2204460492503131e-016

/* MSVC 上 long double 就是 double（与 gcc 在 Windows 上一致）。 */
#define LDBL_MANT_DIG DBL_MANT_DIG
#define LDBL_DIG DBL_DIG
#define LDBL_MIN_EXP DBL_MIN_EXP
#define LDBL_MAX_EXP DBL_MAX_EXP
#define LDBL_MIN DBL_MIN
#define LDBL_MAX DBL_MAX
#define LDBL_EPSILON DBL_EPSILON

#define DECIMAL_DIG 17
#define FLT_ROUNDS 1
#define FLT_EVAL_METHOD 0

#endif /* __OMNI_MSVC_FLOAT_H */
