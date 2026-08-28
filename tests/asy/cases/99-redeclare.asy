// 第六十五刀：同一层里**重新声明**同名的变量 —— asy 收（新开一格，把旧的那格遮住）。
// plain 里三处这么写：plain_arrows.asy:70/112 的 `path left=…`、plain_filldraw.asy:28 的
// `real t=…`。类型相同时这一层复用同一格，把后一句降成赋值。

int x = 1;
int x = 2;
write(x);

// 函数体里，且后一句的初值用了前一格的值
void f() {
  real t = 1;
  real t = t + 1;
  write(t);
}
f();

// 数组、struct、函数值三种聚合也各来一次
struct S { int n; }
using ifn = int(int);
void g() {
  int[] a = new int[] {1, 2};
  int[] a = new int[] {3};
  write(a.length);
  S s;
  s.n = 5;
  S s;
  write(s.n);           // 新开的那一格是 new S，n 回到 0
  int hop(int k) { return k + 1; }
  ifn h = hop;
  ifn h;
  write(h == null);
}
g();

// 嵌套的那一层照旧是遮住，不是复用
void k() {
  int v = 1;
  { int v = 2; write(v); }
  write(v);
}
k();
