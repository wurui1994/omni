// 超越函数：`exp` 走 Omni 运行库（stage0/lib/math.sx 里的 omni_exp），不是宿主的 libm。
// 这一节的契约：五条腿之间**逐字节**相同，与真 asy 只要求容差内相等（理由见 run.js 的注释）。
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
