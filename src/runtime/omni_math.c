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
#define OMNI_REFID_IMPL_TU 1
#include "omni.h"
#include <math.h>
#include <string.h>

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

/* `fma` —— 那个交集的**第二条例外**（ADR-0019 路 2、ADR-0014 第十五节）：`Math.*` 里
   没有它，而「一次舍入的 a*b+c」用别的算符做不出来（分两步算差最后一位）。

   为什么要它：参考实现（asy）是 C++ 编译出来的，`a*b + c*d` 这类式子在 arm64 上被
   收缩成一条 `fmadd`（例如 pair.h:139 的 `abs2()` 里 `x*x+y*y`）。要与那份字节对上，
   我们这一侧也得有单次舍入的 fma。

   这一条是**权威**：JS 那侧（prelude 里 Dekker 拆分 + two-sum）要与它逐字节对上。
   能这么要求的理由与 `nextafter` 一样 —— fma 是**精确运算**（IEEE-754 5.4.1 只舍一次），
   与上面那些超越函数（只保证容差）不同。 */
double omni_r_fma(double x, double y, double z) { return fma(x, y, z); }

/* `nextafter` —— 那个「C99 ∩ Math.*」交集的**例外**（ADR-0019 路 2）：`Math.*` 里
   没有它，而区间算术要「往上/往下挪一个 ulp」才能保证结果是真超集。

   这一条是**权威**：JS 那侧（`$js_math` 的 'W'）是手写的，它要与这里逐字节对上。
   为什么能要求逐字节 —— 与上面那些超越函数不同，nextafter 是**精确运算**
   （IEEE-754 5.3.1 的 nextUp/nextDown），不存在「哪家 libm 的最后一位」这回事。 */
double omni_r_nextafter(double x, double y) { return nextafter(x, y); }

/* 位重解释（ADR-0019 路 1）：`(realbits E)` / `(bitsreal E)`。**不是**转换 —— 位不动，
   只换一种读法。走 memcpy 而不是指针别名：后者在 -O2 下是严格别名违规（编译器有权
   假定 double* 与 int64_t* 不指向同一处），memcpy 是标准认可的那一手，而且各家编译器
   都会把这 8 个字节的 memcpy 折成一条寄存器搬运。

   宽度是 64 对 64，所以两个方向都精确。GLSL 那两个内建是 32 位的（规范假定 float 是
   f32），差别由 GLSL 那一侧的注释交代。 */
int64_t omni_r_bits(double x) { int64_t i; memcpy(&i, &x, sizeof i); return i; }
double omni_r_frombits(int64_t i) { double x; memcpy(&x, &i, sizeof x); return x; }

/* `(refid E)` 的真符号（run-llvm 那条腿 call 它；C 那条腿走 omni.h 里的宏，
   一次强转、不付调用）。指针值就是身份 —— arena 里的块不会搬家，所以这个数在
   一次运行里是稳的。**不承诺跨运行稳定**，所以它只配当散列桶的下标。 */
int64_t omni_refid(const void *p) { return (int64_t)(intptr_t)p; }



