// 用户转换的代价**跟内建提升一样**：`void p(real)` 与 `void p(V)` 都收得下 `3`，
// 于是 asy 报 "call to 'void p(...)' is ambiguous"。不带 ASY_NOPE。
struct V {
  int n;
}

V operator cast(int x) {
  V v = new V;
  v.n = x;
  return v;
}

void p(real r) {
  write(r);
}

void p(V v) {
  write(v.n);
}

p(3);
