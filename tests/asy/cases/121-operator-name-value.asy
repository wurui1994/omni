// 算符名在两个位置上都是**普通名字**（asy 里算符就是"名字叫 operator X 的函数"）：
//  - 当值传：`maxcoords(coords, operator >=)`（plain_scaling.asy:248）。
//  - 当形参名：`coord[] maxcoords(coord[] in, bool operator <= (coord,coord))`
//    （plain_scaling.asy:41 —— 那边源码 :43 有注释专门说这件事）。体里的 `a <= b`
//    调的是**那一格形参**，不是文件级同名的那份。
struct C { real v; }
C mk(real v) { C c; c.v = v; return c; }
bool operator <= (C a, C b) { return a.v <= b.v; }
bool operator >= (C a, C b) { return a.v >= b.v; }

C pick(C[] in, bool operator <= (C,C)) {
  C best = in[0];
  for (int i = 1; i < in.length; ++i) if (best <= in[i]) best = in[i];
  return best;
}
C[] cs = { mk(3), mk(9), mk(1) };
write(pick(cs, operator <=).v);
write(pick(cs, operator >=).v);

// 重载集靠**目标类型**定案：int 那一支与 C 那一支同名
int operator ^(int a, int b) { return a * 10 + b; }
using cmp = bool(C,C);
cmp le = operator <=;
write(le(mk(1), mk(2)));
write(le(mk(2), mk(1)));
int f(int,int) = operator ^;
write(f(3, 4));

// 文件级那份没被形参遮住的地方照旧
write(mk(1) <= mk(2));
