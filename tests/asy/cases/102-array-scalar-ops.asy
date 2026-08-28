// 第六十八刀：数组与标量的算术（逐元素）——builtin.cc:454 的 addOps<T,op>：每个 op 挂
// 四份：(标量,标量)、(标量,数组)、(数组,标量)、(数组,数组)。addBasicOps 给 + -、times 给 *、
// 非整数的还有 /，int 另有 % #（:749-751）。一元的 - 也有数组那一份。
// int[] -> real[] 是一条**隐式**转换（arrayToArray）—— plain.asy:203 的 sequence(n+1)/n 要靠它。
// 长度不等时照抄 asy 那句 "operation attempted on arrays of different lengths: 2 != 1"。

int[] a = {1,2,3};
int[] b = {10,20,30};
write(3 + a);
write(a + 3);
write(a + b);
write(a - b);
write(2 * a);
write(a % 2);
write(a # 2);
write(-a);
real[] r = a;
write(r / 2);
write(1 / r);
write(r ^ 2);
pair[] p = {(1,2),(3,4)};
write(p / 2);
write(p + (1,1));
write(-p);
triple[] t = {(1,2,3),(4,5,6)};
write(t - (1,1,1));
write(t * 2);

// int[] -> real[] 那条隐式转换（plain.asy:203 的形状）
int[] s = {1,2,3,4};
write(1.5 + s / 3 * 2);
