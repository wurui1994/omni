// 复数幂。asy 是**两个重载**，判据是指数的静态类型而不是它的值（三条测量在
// lower.js 的 asy__ppowi/asy__ppowz 上方写着）：
//   指数是 int  -> 反复平方，整数上是精确的（(1,2)^30 印的是整数，一个小数点都没有）
//   指数是 real / pair -> exp(w * log z)，w*log z 是**复数**乘法，abs 用朴素那一份
// 后一条不是宿主的 cpow：(1e200,1e200)^0.5 在 asy 是 (nan,nan)，cpow 给的是有限值。
// 所以这份用例落在 tol/ 而不是逐字节那一节：反复平方那条的乘法次序与 libstdc++ 的
// __complex_pow_unsigned（复数乘法带 NaN 修补）在最后一位上会分叉。
// 契约同这一节其余用例：腿之间、与真 asy 都只要求最后一位十进制差不超过 1。
write((1,2)^2);
write((1,2)^3);
write((1,2)^13);
write((1,2)^-3);
write((3,4)^0);
write((3,4)^1);
write((1.5,-0.5)^7);
int k=6; write((1,2)^k);
write((1,2)^0.5);
write((1,2)^2.0);
write((1,2)^(2,0));
write((1,2)^(0,1));
write(2^(1,2));
write((-2)^(1,2));
write((-1,0)^0.5);
write((1,1)^(0.5,0.5));
real e=2.5; write((1,2)^e);
write((0,0)^2);
write((0,0)^0.5);
write((0,0)^(0,0));
write((2,3)^(0,0));
write(abs((1,2)^13));
