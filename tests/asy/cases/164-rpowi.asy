// real^int 不是 pow(x,(double)n)：asy 那条重载（mathop.h:191）是**反复平方**，
// 而且按指数的**静态类型**分路 —— `x^k`（k 是 int）与 `x^5.0` 是两个不同的答案。
// 差最后一两位，但 slope.asy 的 dt=lambda^(n-i) 正落在这上面：那点差经 ODE 放大到
// y 轴范围的 1e-12，fit 的缩放于是与参考不同，t*inverse(t) 不再正好是单位，
// 每一笔描边就多套一层 gsave/concat/grestore（asy 比的是六个数的精确相等）。
// 这一格不用 format（那是 plain_strings 的东西，这一轴只跑内建），改成印"差"与"等不等"。
real x=sqrt(0.5);
int k5=5; real e5=5;
write(x^k5 == x^5.0);          // false：静态类型分路
write(x^e5 == x^5.0);          // true：real 指数走 pow
write(x^k5 - x^5.0);
int k4=4;
write(x^k4 == x^4.0);
write(x^k4 - x^4.0);
int k10=10;
write(x^k10 == x^10.0);
write(x^k10 - x^10.0);
// 负指数：先取倒数再算正指数（mathop.h:195 的 `if(y < 0) {y=-y; x=1/x;}`）
int km3=-3;
write(x^km3);
write(3.0^km3);
// 头两条特例：y==0 给 1（x 是什么都一样）、x==0 且 y>0 给 0
int k0=0;
write(x^k0);
write(0.0^k0);
write(0.0^k5);
// 底是负数：反复平方照样对（符号跟着奇偶）
write((-2.0)^k5);
write((-2.0)^k4);
