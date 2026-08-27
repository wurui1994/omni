// struct 的方法（asy 前端第二十刀）。每条都量过（asy -noV）：
//   - 方法体里的裸名字先找局部量/形参，再找**前面声明的**字段（后面的报 no matching variable）；
//   - struct 的成员**遮住**同名的文件级函数；
//   - 方法里改字段改的是接收者那个对象（asy 的 struct 是引用类型）；
//   - 重载、默认实参、递归在方法上与普通函数一模一样；
//   - `this` 是接收者本身，返回它可以接着点下去。
int who() { return 1; }
int helper(int n) { return n * 2; }

struct P {
  int x;
  real w = 0.5;
  int who() { return 2; }
  int get() { return x + 10; }
  void bump(int k) { x += k; }
  int viaOther() { return get() * 2; }
  int usesThis() { return this.x + 1; }
  int shadow(int x) { return x + this.x; }
  int callsFileFn(int n) { return helper(n) + who(); }
  int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
  int ov(int n) { return n; }
  real ov(real n) { return n + 0.25; }
  int def(int n = 5) { return n * 10; }
  P self() { return this; }
  real area() { return x * w; }
}

P mk(int n) {
  P p = new P;
  p.x = n;
  return p;
}

P a;
a.x = 3;
write(a.get());
a.bump(5);
write(a.x);
write(a.viaOther());
write(a.usesThis());
write(a.shadow(100));
write(a.callsFileFn(4));
write(a.fact(5));
write(a.ov(2));
write(a.ov(2.0));
write(a.def());
write(a.def(1));
write(a.area());

// this 回来的是同一个对象：接着点下去改的还是它
a.self().bump(100);
write(a.x);
write(a.self().get());

// 引用语义：副本与本体是同一个对象
P b = a;
b.bump(1);
write(a.x);

// 方法调用的接收者可以是任意表达式：函数返回值、数组元素、字段
write(mk(7).get());
P[] ps;
ps.push(mk(2));
ps.push(mk(4));
ps[1].bump(30);
write(ps[1].x);
write(ps[0].get());

struct Box {
  P inner;
  int sum() { return inner.get() + 1; }
}
Box bx;
bx.inner.bump(6);
write(bx.inner.x);
write(bx.sum());
write(bx.inner.get());
