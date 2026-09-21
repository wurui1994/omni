// 算术：asy 与核心方言不一致的四个算符全在这里 —— `/` 永远是实数除法，
// `#` 向下取整，`%` 的符号跟着除数，`^` 是幂。
int a = 17, b = 5;
write(a + b);
write(a - b);
write(a * b);
write(a # b);
write(a % b);
write(-17 # 5);
write(-17 % 5);
write(17 % -5);
write(2 ^ 10);
write((-2) ^ 3);
write(1 / 4 == 0.25);  // 实数除法：0.25，不是 0
write(3 * 2 + 4 # 2);  // 优先级：* 和 # 同级，都高于 +
write(2 ^ 3 ^ 2);      // 幂右结合：2^9
int c = a;
c += b;
write(c);
c -= 2;
write(c);
c *= 3;
write(c);
c #= 4;
write(c);
c %= 7;
write(c);
++c;
write(c);
--c;
write(c);
real r = 2.5;
// real 的**打印**在 06-reals.asy 里单独钉（asy 是 %.15g）；这里钉的是 real 的**算术**，
// 所以比较而不是打印 —— 一份用例只证一件事。
write(r * 2 == 5.0);
write(r + 0.5 == 3.0);
write(-r < 0);
write(a < b);
write(a > b);
write(a == 17);
write(a != 17);
write(a >= 17 && b <= 5);
write(a > 100 || b == 5);
write(!(a == b));
