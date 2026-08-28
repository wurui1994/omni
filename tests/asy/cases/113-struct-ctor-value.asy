// struct 名字当**值**用就是那一族构造函数（collections/genericpair.asy:27 的
// `Pair_K_V makePair(K k, V v) = Pair_K_V;`）。是哪一份由**目标类型**定案。
struct P {
  restricted int k;
  restricted string v;
  void operator init(int k, string v) { this.k = k; this.v = v; }
  void operator init(int k) { this.k = k; this.v = "?"; }
}
P makeP(int k, string v) = P;
P oneP(int k) = P;
P a = makeP(3, "x");
write(a.k); write(a.v);
P b = oneP(9);
write(b.k); write(b.v);
// 直接当实参传：槽的类型就是目标类型
P apply(P f(int), int n) { return f(n); }
write(apply(P, 5).k);
write(apply(oneP, 6).v);
// 造出来的是**新的**对象，不是同一格
P c = makeP(1, "y");
P d = makeP(1, "y");
write(alias(c, d));
write(c.k == d.k);
