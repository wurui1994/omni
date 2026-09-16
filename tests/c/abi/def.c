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
