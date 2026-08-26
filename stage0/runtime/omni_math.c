/* 实数上的数学函数。只收**各家实现必然一致**的那几个：

   - `sqrt` 是 IEEE-754 强制正确舍入的，所以到哪都是同一个位。
   - `fabs` / `floor` / `ceil` / `round` / `fmod` 都是精确运算（结果本来就可表示）。
   - `pow` 不是强制正确舍入的，但量过：80 组随机双精度输入上 macOS 的 libm 与 V8 的
     Math.pow 逐位相同。它进这张表是因为 asy 的 `^` 要它。

   刻意**不收** exp / log / tan / atan / cos 这一类：同样量过，libm 与 V8 在最后一位就
   分叉（`atan(0.5)`：libm 0.46364760900080615，V8 …09；`log(3)`、`tan(1.5)`、
   `cos(0.1)` 同样差一位）。收了它们，"五条腿逐字节相同"这条纪律就成了摆设 ——
   要做就得自己写一份共用的实现，那是另一件事。

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
