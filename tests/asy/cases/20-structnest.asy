// struct 套 struct（第十七刀）。asy 的 struct 是引用类型，所以内嵌的字段降成核心方言的
// **类字段**（一个句柄）—— 量出来的三条：`B b;` 会给里面那个 A 也跑一遍 operator init
// （字段默认值都在），`b.a = other` 之后两边是**同一个**对象，`B c = b` 之后 c.a 也是它。
struct A {
  int x;
  real y = 1.5;
}

struct P {
  A lo;
  A hi;
  string tag;
}

real span(P p) { return p.hi.y - p.lo.y; }
void poke(P p) { p.lo.x = 5; }
A pick(P p, bool first) { return first ? p.lo : p.hi; }

P p;
// 零值：内嵌的 A 是**新对象**，不是空引用，而且它的默认值也求过了
write(p.tag);
write(p.lo.x);
write(p.lo.y);
write(p.hi.y);
write(span(p));

// 穿过一层写里面的标量
p.lo.x = 7;
p.lo.y = 0.5;
write(p.lo.x);
write(p.lo.y);
write(span(p));
p.lo.x += 3;
++p.lo.x;
write(p.lo.x);

// 两个内嵌字段是**各自**的对象
write(p.hi.x);
p.hi.x = 100;
write(p.lo.x);
write(p.hi.x);

// 整个字段换掉：换的是句柄，之后两边是同一个对象
A other;
other.x = 42;
p.lo = other;
write(p.lo.x);
other.x = 43;
write(p.lo.x);
write(p.lo == other);
write(p.lo == p.hi);

// struct 本身也是引用：c 就是 p
P c = p;
c.lo.x = 99;
write(p.lo.x);
c.tag = "t";
write(p.tag);

// 改形参里内嵌字段的字段，外面看得见
poke(p);
write(p.lo.x);

// 内嵌字段当返回值（回的是句柄）
write(pick(p, true).x);
write(pick(p, false).x);
pick(p, true).x = 11;
write(p.lo.x);

// 每次构造都是新的内嵌对象，默认值也重新求
for (int i = 0; i < 3; ++i) {
  P q;
  q.lo.x = i;
  write(q.lo.x);
  write(q.lo.y);
}
