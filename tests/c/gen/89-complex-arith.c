/* 第一百五十二片：复数**算术**那一半（ADR-0047）。
 *
 * 这一格只判**不用链运行时**的那几条：`+ - 一元-`（逐分量，精确）、虚数字面量、
 * 实数与复数的互转、`__real__` / `__imag__`（GNU，可以当左值）、`==` / `!=`。
 *
 * `*` 与 `/` **不在这儿**：它们发成对 `__muldc3` / `__divdc3` 的调用，而那两个的身子在
 * `ext/r/rt/omni_complex.c` 里（一份 .c 一份 .js 那条路上链进去）——
 * 判据在 `tests/r/rtc.js` 第二节，那儿与 clang 比含 Inf/NaN 的十行。
 *
 * 判据照这一组的规矩：与 cc 编出来的退出码逐字节相同。数都取 2 的幂的分数
 * （1.5 / 2.0 / 0.25 …），于是"谁把乘加收成一条 FMA"这件事影响不到结果。 */

int main(void) {
  int s = 0;

  double _Complex a = 1.5 + 2.0i;
  double _Complex b = 0.5 - 1.0i;

  /* 逐分量的加减 */
  double _Complex p = a + b;                 /* 2 + 1i   */
  double _Complex m = a - b;                 /* 1 + 3i   */
  s += (int)(__real__ p * 2);                /*  4 */
  s += (int)(__imag__ p * 3);                /*  3 -> 7 */
  s += (int)(__real__ m * 5);                /*  5 -> 12 */
  s += (int)(__imag__ m * 6);                /* 18 -> 30 */

  /* 一元负 */
  double _Complex n = -a;
  s += (int)(__real__ n * -2);               /*  3 -> 33 */
  s += (int)(__imag__ n * -4);               /*  8 -> 41 */

  /* 实数与复数互转：`(double)z` 丢虚部，`(double _Complex)x` 虚部是 0 */
  double re = (double)a;
  s += (int)(re * 4);                        /*  6 -> 47 */
  double _Complex c2 = (double _Complex)3.25;
  s += (int)(__real__ c2 * 4);               /* 13 -> 60 */
  s += (int)(__imag__ c2 + 7);               /*  7 -> 67 */

  /* 赋值：实数赋给复数要转（虚部清零），复数之间按分量拷 */
  double _Complex z = a;
  z = 2.5;                                   /* 2.5 + 0i */
  s += (int)(__real__ z * 2);                /*  5 -> 72 */
  s += (int)(__imag__ z + 8);                /*  8 -> 80 */

  /* `__real__` / `__imag__` 当**左值** —— R 的 Rcomplex.h 靠这条造复数 */
  __real__ z = 4.0;
  __imag__ z = -0.5;
  s += (int)(__real__ z * 2);                /*  8 -> 88 */
  s += (int)(__imag__ z * -4);               /*  2 -> 90 */

  /* 相等：两个分量都相等才算 */
  s += (a == a) ? 10 : 0;                    /* 10 -> 100 */
  s += (a == b) ? 100 : 0;                   /*  0 -> 100 */
  s += (a != b) ? 20 : 0;                    /* 20 -> 120 */
  s += (a != a) ? 100 : 0;                   /*  0 -> 120 */

  /* 混着实数算：实数当"虚部是 0 的复数" */
  double _Complex q = a + 1.0;               /* 2.5 + 2i */
  s += (int)(__real__ q * 2);                /*  5 -> 125 */
  s += (int)(__imag__ q * 5);                /* 10 -> 135 */

  /* sizeof 那几格（第一百五十二片前半已经判过，这儿顺手钉一次） */
  s += (int)sizeof(a);                       /* 16 -> 151 */

  return s & 255;                            /* 151 */
}
