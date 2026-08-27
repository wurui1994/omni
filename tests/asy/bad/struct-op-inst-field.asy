// struct 体里**不带 static** 的算符重载，体里读实例字段：asy 收（量过印 16 —— 那份算符
// 绑住了接收者），我们不收。我们的算符降成"没有接收者的函数"，要收得对得给它造一个闭包，
// 与"把方法当值取出来"是同一件事（见 bad/fn-value）。
struct V { int n = 3; }
struct S {
  int bump = 10;
  V operator *(int k, V v) { V r = new V; r.n = k * v.n + bump; return r; }
  V a = new V;
  int use() { V b = 2 * a; return b.n; }
}
S s = new S;
write(s.use());
