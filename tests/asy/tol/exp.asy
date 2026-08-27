// 超越函数：`exp` 走绑定表的 rmath 那一列 —— C 那条腿转手 libm，JS 那条腿转手 Math.exp。
// 这一节的契约：腿与腿之间、以及与真 asy，都只要求最后一位十进制差不超过 1
// （理由见 run.js 的注释：libm 与 V8 两边都不是正确舍入的）。
// 这份用例里 `exp(-10.0)` 就是分叉的那一处：Math.exp 印 4.53999297624848e-05，
// libm 印 …49e-05，真 asy 跟 libm 一边。
write(exp(0.0));
write(exp(1.0));
write(exp(-1.0));
write(exp(0.5));
write(exp(-3.25));
write(exp(10.0));
write(exp(-10.0));
write(exp(100.0));
write(exp(-100.0));
write(exp(700.0));
write(exp(1e-9));

// 整数实参走隐式提升
write(exp(2));

// 表达式里、循环里都一样
real s = 0.0;
for (int i = 0; i < 5; ++i) s += exp(i * 0.25);
write(s);
