// 第六十六刀：`from T unravel N;` 里 N 是 T 体里声明的**类型**（geometry.asy:5616/5617
// 的 `side` 与 `vertex`），以及同名的**记录名与函数名**在同一个重载集里（geometry.asy:5713
// 的 `triangle triangle(line,line,line)` 与 struct triangle 的 `operator init`）。
struct Outer {
  struct inner {
    int n;
    Outer up;
  }
  inner mk(int n) { inner v = new inner; v.n = n; v.up = this; return v; }
  // 与嵌套类型同名的方法：摊出去的是**类型**那一格，不是这个
  inner inner(int n) { return mk(n + 100); }
  int k;
  void operator init(int k) { this.k = k; }
}

from Outer unravel inner;

Outer a = Outer(7);
inner p = a.mk(3);
inner q = a.inner(3);
write(a.k);
write(p.n);
write(q.n);
write(p.up.k);

// 记录名与函数名同一个重载集：`Outer(...)` 两条路都要认
Outer Outer(string s) { return Outer(length(s)); }
Outer b = Outer("abcd");
write(b.k);
Outer c = Outer(11);
write(c.k);

// 局部量遮住同名形参时，重载按**里层那一格**的类型挑（bezulate.asy:64 那一条）
int bez(path[] p) {
  path p2 = (0,0)--(1,1);
  path p = p2;
  return size(p);
}
write(bez(new path[] {(0,0)--(1,1)--(2,0)}));

// dot 的两族在同一个重载集里：两个 triple 走 `real dot(triple,triple)`，
// 三个实参走 plain_markers 的 `void dot(picture,pair,pen)`（graph3.asy:84 那一条）
triple u = (1,0,0), v = (0,1,0);
write(dot(u, v));
write(dot(u, u));
pair z = (1,2), w = (3,4);
write(dot(z, w));

// 这一批内建
write(gamma(5));
write(gamma(2.5));
write(gamma(0.5));
write(gamma(-1.5));
write(abs2((3,4)));
write(abs2((1,2,2)));
write(true ^ false);
write(sum(new real[] {1,2,3.5}));
write(sum(new bool[] {true,false,true}));
real[] xs = {1,4,9};
real dbl(real x) { return 2x; }
write(map(dbl, xs));
write(concat(new bool[] {true}, new bool[] {false}));
