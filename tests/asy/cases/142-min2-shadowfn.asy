// (1) min/max 的**二维**那一份（arrayop.h:90 的 binopArray2）：空的那一行跳过。
// palette.asy:75/:270 的 `min(f)`、`max(f)` 就是这一份。
int[][] a={{3,1},{},{ -2,7}};
write(min(a));
write(max(a));
real[][] b={{},{2.5},{0.5,9.5}};
write(min(b));
write(max(b));
string[][] c={{"b"},{},{"a","c"}};
write(min(c));
write(max(c));

// (2) 函数类型的**形参**被同一层里同名的非函数局部量遮住之后，调的还是形参那一格
// （asy 的 venv 按签名逐层找：一个有签名、一个没有，两格共存）。
// palette.asy:300 的 `void palette(…, axis axis=Right, …)` 体里第 309 行又写了
// `axisT axis;`，:310 的 `axis(pic,axis)` 就是这一对。
struct S {
  int v;
}
typedef int fn(S);
int twice(S s) { return 2*s.v; }
int use(fn axis=twice) {
  S axis;
  axis.v=21;
  return axis(axis);
}
write(use());
write(use(new int(S s) { return s.v+1; }));
