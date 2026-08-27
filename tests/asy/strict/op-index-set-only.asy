// `operator [=]` 没配 `operator []` —— asy 自己就拒：量过报
// "operator[=] defined without operator[]"。这一条**不带** ASY_NOPE。
struct D {
  int[] a;
  void operator [=] (int i, int v) { a[i] = v; }
}
write(1);
