// 函数类型的字段（plain_filldraw.asy:93 的 `fill2 fill2;` 就是这个形状）：
// 存的是一个句柄，`b.f(…)` 是通过它间接调。字段与体里的 using 同名也没关系 ——
// 类型名与变量名是两个名字空间。
struct Box {
  using fn2=int(int);
  fn2 fn2;
  int n = 5;
}

Box b;
b.fn2 = new int(int x){return x+1;};
write(b.fn2(4));
write(b.n);

// 默认值就写在字段上（右边是一个已经声明过的函数）
int base = 100;
int addbase(int x) { return x + base; }
struct Adder {
  using ifn=int(int);
  ifn f = addbase;
}
Adder a;
write(a.f(7));
a.f = new int(int x){return x*3;};
write(a.f(7));

// 另一个对象有自己的那一格，默认值照样铺
Adder a2;
write(a2.f(7));

// 字段是函数值时 struct 照样能当实参传（引用语义）
void bump(Adder t) { t.f = new int(int x){return x-1;}; }
bump(a);
write(a.f(7));
