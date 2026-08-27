// `sin`/`cos` 走绑定表的 rmath 那一列：C 那条腿转手 libm，JS 那条腿转手 Math.sin/cos。
// 契约同这一节其余用例：腿之间、与真 asy 都只要求最后一位十进制差不超过 1。
//
// 刻意**不**取 sin/cos 的零点附近（sin(pi)、cos(pi/2) 那种）：那里结果本身是
// 1e-16 量级的抵消值，相对误差没有意义，两份 libm 在那里差多少都不奇怪。
write(sin(0.0));
write(sin(0.5));
write(sin(-0.5));
write(sin(1.0));
write(sin(2.0));
write(sin(3.0));
write(sin(4.0));
write(sin(-7.5));
write(sin(100.0));
write(sin(12345.678));
write(sin(1e6));

write(cos(0.0));
write(cos(0.5));
write(cos(-0.5));
write(cos(1.0));
write(cos(2.0));
write(cos(3.0));
write(cos(4.0));
write(cos(-7.5));
write(cos(100.0));
write(cos(12345.678));
write(cos(1e6));

// 整数实参走隐式提升
write(sin(2));
write(cos(3));

// 象限四个方向各取一个（离零点远的那半边）
write(sin(0.7853981633974483));
write(sin(2.356194490192345));
write(sin(3.9269908169872414));
write(sin(5.497787143782138));
write(cos(0.7853981633974483));
write(cos(2.356194490192345));
write(cos(3.9269908169872414));
write(cos(5.497787143782138));

// sin^2 + cos^2 = 1
real x = 1.234;
write(sin(x) * sin(x) + cos(x) * cos(x));

// 表达式里、循环里都一样
real s = 0.0;
for (int i = 0; i < 5; ++i) s += sin(i * 0.25) + cos(i * 0.5);
write(s);
