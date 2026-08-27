// `atan`/`atan2` 走绑定表的 rmath 那一列：C 那条腿转手 libm，JS 那条腿转手 Math.atan/atan2。
// 契约同这一节其余用例：腿之间、与真 asy 都只要求最后一位十进制差不超过 1。
write(atan(0.0));
write(atan(1.0));
write(atan(-1.0));
write(atan(0.5));
write(atan(2.0));
write(atan(10.0));
write(atan(-100.0));
write(atan(0.1));
write(atan(1e-7));
write(atan(1e7));

// 整数实参走隐式提升
write(atan(1));

// atan2：四个象限 + 轴上
write(atan2(1.0, 1.0));
write(atan2(1.0, -1.0));
write(atan2(-1.0, -1.0));
write(atan2(-1.0, 1.0));
write(atan2(0.0, 1.0));
write(atan2(0.0, -1.0));
write(atan2(1.0, 0.0));
write(atan2(-1.0, 0.0));
write(atan2(3.0, 4.0));
write(atan2(-2.5, 0.75));

// 与 sin/cos 一起用：atan2(sin t, cos t) 应该回到 t
real t = 0.7;
write(atan2(sin(t), cos(t)));

// 表达式里、循环里都一样
real s = 0.0;
for (int i = 0; i < 5; ++i) s += atan(i * 0.5);
write(s);
