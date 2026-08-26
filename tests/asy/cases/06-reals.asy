// real 的输出：asy 的默认是 %.15g（量过，逐条）。核心方言的 `(tostr E N)` 就是为这个
// 加的 —— 默认那份 %.6g 是"看值用的"，在这里逐字节对不上。
write(1/3);
write(0.5);
write(0.1+0.2);
write(1e20);
write(1.0);
write(0.0);
write(-2.5);
write(1234.5678);
write(1e-5);
write(123456789012345678.0);
write(-0.0);
write("r = ", 2.5);
write(1.5, 2.5);
real x = 7;    // int 字面量给 real 变量：asy 会提升
write(x);
write(3/4*2);  // 全程实数：1.5，不是 0
real y = 2;
y /= 4;
write(y);
y *= 3;
write(y);
write(1/3 + 1/3 + 1/3);
write((real) 7 / (real) 2);
write(0.1 * 3);
