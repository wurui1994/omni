// 第六十六刀：函数体里的**具名**函数抓外层的局部量 —— 降成闭包，绑在一个同名的局部量上。
// base 里四处，plain_picture.asy:979 的 `void drawAll(...)` 抓 `oldnodes` 是其中一处。

void outer() {
  int k = 10;
  int add(int x) { return x + k; }
  write(add(1));
  write(add(2));
}
outer();

// 抓的是形参，且闭包在循环里被调多次
real[] shift(real off) {
  real[] out;
  real value(int i) { return i + off; }
  for (int i = 0; i < 3; ++i) out.push(value(i));
  return out;
}
write(shift(0.5));

// 抓数组（引用语义：闭包里往里塞，外面看得见）
void collect() {
  int[] seen;
  void note(int v) { seen.push(v); }
  note(1);
  note(2);
  write(seen.length);
  write(seen[1]);
}
collect();

// 抓 struct（同样是引用语义）
struct Box { int n; }
void bump() {
  Box b;
  void up() { b.n = b.n + 1; }
  up();
  up();
  write(b.n);
}
bump();

// 不抓外层的那种照旧降成顶层函数（这一条是回归：两条路都还在）
void plainNested() {
  int twice(int x) { return 2 * x; }
  write(twice(21));
}
plainNested();
