// `log` 走 Omni 运行库（omni_log）：x = m*2^k 的归约只用乘/除 2 的幂，
// ln(x) = k*ln2 + 2*atanh((m-1)/(m+1))。契约同这一节其余用例：五条腿逐字节相同，
// 与真 asy 只要求最后一位十进制差不超过 1。
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

// 与 exp 互为反函数（同一份运行库里的两个函数一起用）
write(log(exp(2.5)));
write(exp(log(7.0)));

// 表达式里、循环里都一样
real s = 0.0;
for (int i = 1; i < 6; ++i) s += log(i * 1.0);
write(s);
