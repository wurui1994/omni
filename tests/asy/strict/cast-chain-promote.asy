// 用户转换**不串**（二）：只有 `V operator cast(real)` 时 `int` 到 `V` 不通 ——
// 内建的 int->real 提升不会先跑一遍再接用户那份（量过 asy 报
// "cannot call 'void p(V v)' with parameter 'int'"）。不带 ASY_NOPE。
struct V {
  int n;
}

V operator cast(real x) {
  V v = new V;
  v.n = (int) x;
  return v;
}

void p(V v) {
  write(v.n);
}

p(3);
