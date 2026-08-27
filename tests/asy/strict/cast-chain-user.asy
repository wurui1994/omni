// 用户转换**不串**（一）：`A operator cast(int)` 加 `B operator cast(A)` 之后
// `int` 到 `B` 还是不通 —— 量过 asy 报 "cannot call 'int q(B b)' with parameter 'int'"。
// 不带 ASY_NOPE：这个程序在 asy 那边本来就不对。
struct A {
  int n;
}

struct B {
  int n;
}

A operator cast(int x) {
  A a = new A;
  a.n = x;
  return a;
}

B operator cast(A a) {
  B b = new B;
  b.n = a.n;
  return b;
}

int q(B b) {
  return b.n;
}

write(q(5));
