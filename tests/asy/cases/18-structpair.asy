// struct 的 pair 字段（第十五刀）。核心方言的类字段现在收 (vec T N)，而 asy 的 pair
// 就降成 (vec real 2) —— 所以这一份盯的是"pair 字段上，pair 那一整套操作一条不少"。
struct S {
  pair p;
  pair q = (1.5,2.5);
  int n = 3;
}

// pair 字段进出函数：struct 是引用语义，改形参的字段外面看得见
void shift(S s, pair d) { s.p += d; }
pair mid(S s) { return (s.p + s.q) / 2; }

struct T { pair a; pair b; }

real cross(T t) { return t.a.x * t.b.y - t.a.y * t.b.x; }

S mk(real x, real y) {
  S s;
  s.p = (x,y);
  return s;
}

// 零值与默认值
S a;
write(a.p);
write(a.q);
write(a.n);

// 读写、复数乘除、逐分量
a.p = (3,4);
write(a.p);
write(abs(a.p));
write(a.p * a.q);
write(a.p / (0,1));
write(conj(a.p));
a.p += (1,1);
write(a.p);
a.p *= 2;
write(a.p);

// 三层的点：字段的分量
write(a.p.x);
write(a.p.y);
write(xpart(a.q));
write(ypart(a.q));

// 引用语义：b 与 a 是同一个对象
S b = a;
b.p = (9,9);
write(a.p);
write(b.p);

// 改形参的字段外面看得见
shift(a, (1,2));
write(a.p);
write(mid(a));

// 每次构造都重求默认值，而且是独立的对象
S c = mk(0.5, 0.25);
write(c.p);
write(c.q);
write(c.n);
write(a.p);

// 两个 pair 字段一起用
T t;
t.a = (1,2);
t.b = (3,4);
write(cross(t));

// pair 字段进条件与 ?:
write(a.p == b.p);
write(a.p != c.p);
write(a.n > 2 ? a.q : c.p);

// 循环里反复构造：每轮一个新对象，默认值重新求
real acc = 0;
for (int i = 0; i < 3; ++i) {
  S e;
  e.p = (i, i+1);
  acc += xpart(e.p) + ypart(e.q);
}
write(acc);
