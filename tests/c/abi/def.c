/* 定义那一半（见 `abi.h`）。故意让每个 take* 都**读遍**每个成员：少读一个成员，
 * 「那一格摆错了」就可能碰巧不显形。 */
#include "abi.h"

long long take8(S8 s) { return s.a; }
long long take16(S16 s) { return s.a * 100 + s.b; }
long long take24(S24 s) { return s.a * 10000 + s.b * 100 + s.c; }
double takeD2(D2 d) { return d.x * 10 + d.y; }
double takeF3(F3 f) { return (double)f.p * 100 + (double)f.q * 10 + (double)f.r; }
long long takeI12(I12 v) { return v.i * 10000 + v.j * 100 + v.k; }
long long takeC5(C5 v) { return v.c[0] * 100 + v.c[4]; }
long long mix(long long z, S16 s, double d, D2 dd, S24 big, int t) {
  return z + s.a + s.b + (long long)d + (long long)dd.x + (long long)dd.y
    + big.a + big.b + big.c + t;
}

/* 变参那一格（见 abi.h 第九条）：每个成员都乘一个不同的权重再加起来 ——
   哪一格读串位了，答案就一定不同（少读一个成员的话可能碰巧不显形）。 */
long long vamix(int n, ...) {
  __builtin_va_list ap;
  long long acc = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) {
    S24 big = __builtin_va_arg(ap, S24);        /* >16：arm64 上格子里是个指针 */
    S16 two = __builtin_va_arg(ap, S16);        /* ≤16：摊在格子里 */
    double d = __builtin_va_arg(ap, double);
    D2 dd = __builtin_va_arg(ap, D2);           /* HFA，可变参里照旧走栈 */
    int t = __builtin_va_arg(ap, int);
    acc += big.a * 1000000 + big.b * 100000 + big.c * 10000
      + two.a * 1000 + two.b * 100
      + (long long)d * 10 + (long long)dd.x * 3 + (long long)dd.y * 5 + t;
  }
  __builtin_va_end(ap);
  return acc;
}

S8 mk8(long long a) { S8 s; s.a = a; return s; }
S16 mk16(long long a, long long b) { S16 s; s.a = a; s.b = b; return s; }
S24 mk24(long long a, long long b, long long c) { S24 s; s.a = a; s.b = b; s.c = c; return s; }
D2 mkD2(double x, double y) { D2 d; d.x = x; d.y = y; return d; }
F3 mkF3(float p, float q, float r) { F3 f; f.p = p; f.q = q; f.r = r; return f; }
I12 mkI12(int i, int j, int k) { I12 v; v.i = i; v.j = j; v.k = k; return v; }
C5 mkC5(char c0, char c4) {
  C5 v;
  v.c[0] = c0;
  v.c[1] = 0;
  v.c[2] = 0;
  v.c[3] = 0;
  v.c[4] = c4;
  return v;
}
