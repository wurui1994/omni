// struct 体里声明的算符重载，在**体外**用（第四十刀）：asy 报
// "no matching function 'operator *(int, V)'" 并退 1 —— "体里可见"这一条不能顺手做成
// "全局可见"，那就是比 asy 多接受一门语言。
struct V { int n = 3; }
struct S {
  static V operator *(int k, V v) { V r = new V; r.n = k * v.n; return r; }
  V a = new V;
  int use() { V b = 2 * a; return b.n; }
}
V c = new V;
V d = 3 * c;
write(d.n);
