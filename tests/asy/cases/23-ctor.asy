// struct 的构造函数 `void operator init(…)`（asy 前端第二十一刀）。每条都量过（asy -noV）：
//   - `A(…)` 是构造调用：造对象（**字段默认值先铺好**）、跑体、回那个对象；
//   - 返回类型必须是 void 才算构造函数（`int operator init(int)` 之后 `A(3)` 报
//     "no matching variable 'A'"），而 `A a;` **不**走它 —— 那条只认文件级的 operator init；
//   - 重载、默认实参、命名实参在构造函数上与普通函数一模一样；
//   - 默认值能引用**字段**（说明它是在对象造好之后、在体之前求的）；
//   - 体里能调本记录的方法，`return;` 提前收也行；
//   - 造出来的还是引用语义的那个对象（`A b = A(1); A c = b;` 之后改 c 也改 b）。
struct A {
  int x;
  real w = 0.5;
  int seen = 8;
  void operator init() { x = -1; }
  void operator init(int x) { this.x = x; seen = seen + 1; }
  void operator init(int x, int bonus) { this.x = x + bonus; }
  void operator init(real r, int k = 3) { x = (int) r + k; }
  int get() { return x + 10; }
  void operator init(string s) { x = length(s); if (x > 2) return; x = 100; }
  int twice() { return get() * 2; }
  void operator init(bool b, int n = 7) { x = b ? twice() + n : n; }
}

A a0 = A();
write(a0.x); write(a0.w); write(a0.seen);
A a1 = A(5);
write(a1.x); write(a1.seen);
A a2 = A(5, 100);
write(a2.x);
A a3 = A(2.7);
write(a3.x);
A a4 = A(2.7, 10);
write(a4.x);
A a5 = A("abcd");
write(a5.x);
A a6 = A("ab");
write(a6.x);
A a7 = A(true);
write(a7.x);
A a8 = A(false, 42);
write(a8.x);

// 命名实参也认（走的是同一套 defWrapper）
A a9 = A(x = 9);
write(a9.x);
A a10 = A(3, bonus = 4);
write(a10.x);

// 默认值能引用字段：说明它在对象造好之后才求
struct D {
  int base = 6;
  int got;
  void operator init(int n = base) { got = n; }
}
D d0 = D();
write(d0.got);
D d1 = D(1);
write(d1.got);

// 构造调用就是个表达式：当实参、进数组、直接点下去
int pick(A p) { return p.x * 2; }
write(pick(A(3)));
write(A(4).get());
A[] xs;
xs.push(A(1));
xs.push(A(2, 20));
write(xs[1].x);
write(xs[0].get());

// 引用语义没变：造出来的对象照样是句柄
A b = A(7);
A c = b;
c.x = 70;
write(b.x);

// 内嵌记录字段可以在体里换成新造的
struct Box {
  A inner;
  int tag = 0;
  void operator init(int n) { inner = A(n); tag = n * 2; }
}
Box bx = Box(6);
write(bx.inner.x); write(bx.tag); write(bx.inner.get());

// 数组字段与 pair 字段在构造函数里也是普通字段
struct P {
  pair z;
  int[] ns;
  void operator init(pair z, int n) { this.z = z; for (int i = 0; i < n; ++i) ns.push(i * i); }
}
P p = P((1, 2), 4);
write(p.z); write(p.ns.length); write(p.ns[3]);
write(p.z.x + p.z.y);
