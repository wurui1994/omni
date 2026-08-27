// 第二十七刀：用户定义的转换 `T operator cast(S)` / `T operator ecast(S)`。
// 每一行的期望输出都是 `asy -noV` 印出来的。
struct V {
  int n;
}

V operator cast(int x) {
  V v = new V;
  v.n = x;
  return v;
}

int f(V v) {
  return v.n * 10;
}

// 实参位置
write(f(3));

// 初始化
V a = 7;
write(a.n);

// return
V g() {
  return 5;
}
write(g().n);

// `(T) x` 也走 cast
V b = (V) 9;
write(b.n);

// 数组元素赋值与数组字面量
V[] arr = new V[2];
arr[0] = 4;
write(arr[0].n);
V[] lit = {1, 2};
write(lit[1].n);

// 字段默认值
struct W {
  V v = 6;
}
W w = new W;
write(w.v.n);

// operator ecast：只有 `(T) x` 收它
struct U {
  int n;
}

U operator ecast(int x) {
  U u = new U;
  u.n = x;
  return u;
}

U c = (U) 11;
write(c.n);

// 顺序解析：转换写在后面的那份从这里起才算
struct P {
  int n;
}

P operator cast(int x) {
  P p = new P;
  p.n = x + 100;
  return p;
}

P q = 1;
write(q.n);

// 同一对类型的第二份管后面那一段
P operator cast(int x) {
  P p = new P;
  p.n = x + 200;
  return p;
}

P r = 1;
write(r.n);

// real 源
V operator cast(real x) {
  V v = new V;
  v.n = (int) x + 1000;
  return v;
}

V s = 2.5;
write(s.n);
write(f(3.5));

// 重载算符的操作数也走转换（量过：`a + 1` 里的 1 转成 V）
V operator +(V p, V q) {
  V r = new V;
  r.n = p.n + q.n;
  return r;
}

V t = a + 1;
write(t.n);
