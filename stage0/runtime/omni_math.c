/* 实数上的数学函数：**转手宿主的数学库**。C 这边是 libm，JS 那边是 Math.*，
   解释器走 js_math 的同名 op —— 三条路都只是转手，没有一份自己写的实现。

   为什么不自己写：这些是标准库的东西（C99 的 math.h、ECMA-262 的 Math），
   自己写一份 Taylor/Cody-Waite 是重造轮子，而且造出来的比 libm 差（量过：
   自己那份 sin/cos 2 ULP、atan 4 ULP，libm 一般 <=1 ULP），还得逐个测量维护。

   代价说清楚：libm 与 V8 在最后一位（1 ULP）会分叉 —— 量过，20 万个输入上
   sin/cos/tan/atan/exp/log 的 120 万个结果里 51.1 万个位不同，按 `%.15g` 印出来
   31.7 万个字符串不同；而且拿 bc -l（scale=45）当参考，**两边都不是正确舍入的**
   （macOS libm 的 sin 在 400 个输入里 28 个差 1 ULP，V8 22 个，还不是同一批）。
   所以「五条腿逐字节相同」这条纪律对超越函数**不成立**，超越函数的用例走
   tests/asy/tol/ 那一节：腿与腿之间、以及与真 asy 之间都只要求最后一位十进制
   差不超过 1。sqrt（IEEE 强制正确舍入）、fabs/floor/ceil/round/fmod（精确运算）、
   pow（量过逐位相同）仍然是逐字节的，它们不在容差那一节里。

   这些包装存在的理由是 LLVM 那条腿：它要 call 一个**真符号**，libm 的 sqrt 在 IR 里
   可以是 intrinsic，但 fmod / round 不是，统一包一层最省事。 */
#include "omni.h"
#include <math.h>

double omni_r_sqrt(double x) { return sqrt(x); }
double omni_r_pow(double x, double y) { return pow(x, y); }
double omni_r_fabs(double x) { return fabs(x); }
double omni_r_floor(double x) { return floor(x); }
double omni_r_ceil(double x) { return ceil(x); }
double omni_r_round(double x) { return round(x); }
double omni_r_fmod(double x, double y) { return fmod(x, y); }

/* 超越函数：同样只是转手 libm */
double omni_r_sin(double x) { return sin(x); }
double omni_r_cos(double x) { return cos(x); }
double omni_r_tan(double x) { return tan(x); }
double omni_r_asin(double x) { return asin(x); }
double omni_r_acos(double x) { return acos(x); }
double omni_r_atan(double x) { return atan(x); }
double omni_r_atan2(double y, double x) { return atan2(y, x); }
double omni_r_sinh(double x) { return sinh(x); }
double omni_r_cosh(double x) { return cosh(x); }
double omni_r_tanh(double x) { return tanh(x); }
double omni_r_asinh(double x) { return asinh(x); }
double omni_r_acosh(double x) { return acosh(x); }
double omni_r_atanh(double x) { return atanh(x); }
double omni_r_exp(double x) { return exp(x); }
double omni_r_expm1(double x) { return expm1(x); }
double omni_r_log(double x) { return log(x); }
double omni_r_log10(double x) { return log10(x); }
double omni_r_log1p(double x) { return log1p(x); }
double omni_r_cbrt(double x) { return cbrt(x); }
double omni_r_hypot(double x, double y) { return hypot(x, y); }

