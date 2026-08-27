// 无体的方法声明（`int size();`，collections/iter.asy:5 与 genericpair.asy:24 那一族）。
// asy 那边它**就是一个函数类型的字段、初值 null** —— 量过：赋值之前 `s.size == null` 是
// true，赋完 `s.size()` 就通，struct 里别的方法调 `size()` 读的也是这一格。
struct S {
  int size();
  void grow(int n);
  int twice() { return 2 * size(); }
}

S s;
s.size = new int() { return 21; };
write(s.size());
write(s.twice());

int total = 0;
s.grow = new void(int n) { total += n; };
s.grow(5);
s.grow(7);
write(total);

// 每个对象一格（不是 static）
S t;
t.size = new int() { return 1; };
write(t.size());
write(s.size());

// 返回类型是 struct、形参里带数组的那两种拼法也走同一条路
struct Box { int v; }
struct Q {
  Box make(int v);
  int sum(int[] a);
}
Q q;
q.make = new Box(int v) { Box b = new Box; b.v = v; return b; };
q.sum = new int(int[] a) {
  int r = 0;
  for (int i = 0; i < a.length; ++i) r += a[i];
  return r;
};
write(q.make(9).v);
write(q.sum(new int[] {1, 2, 3}));
