// `log` 走绑定表的 rmath 那一列：C 那条腿转手 libm，JS 那条腿转手 Math.log。
// 契约同这一节其余用例：腿之间、与真 asy 都只要求最后一位十进制差不超过 1。
write(log(1.0));
write(log(2.0));
write(log(0.5));
write(log(2.718281828459045));
write(log(10.0));
write(log(1.5));
write(log(0.1));
write(log(100.0));
write(log(1e-8));
write(log(1e8));
write(log(1e-300));
write(log(1e300));
write(log(1.0000001));
write(log(0.9999999));

// 整数实参走隐式提升
write(log(3));

// 与 exp 互为反函数（两个都走宿主的数学库）
write(log(exp(2.5)));
write(exp(log(7.0)));

// 表达式里、循环里都一样
real s = 0.0;
for (int i = 1; i < 6; ++i) s += log(i * 1.0);
write(s);
