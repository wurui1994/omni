// struct —— 第十四刀。asy 的 struct 是**引用**语义的（量过：`A b = a; b.x = 7;` 之后
// a.x 是 7），所以它降到核心方言的 class，不是 struct。字段这一刀只有标量。

struct P { int x; real y; }

// 传参是引用：函数里改字段，外面看得见
void poke(P p) { p.x = 99; }

P mk(int a, real b) {
  P p = new P;
  p.x = a;
  p.y = b;
  return p;
}

// 零值
P z = new P;
write(z.x);
write(z.y);

// 读写字段
P p = mk(3, 1.5);
write(p.x);
write(p.y);
p.x = 4;
p.y = p.y * 2;
write(p.x);
write(p.y);

// 复合赋值与自增
p.x += 10;
write(p.x);
p.x -= 1;
write(p.x);
p.x *= 2;
write(p.x);
++p.x;
write(p.x);
--p.x;
write(p.x);
p.y /= 2;
write(p.y);
p.x #= 3;
write(p.x);
p.x %= 5;
write(p.x);

// 赋值是别名
P q = p;
q.x = 1000;
write(p.x);

// 传参是别名
poke(p);
write(p.x);

// 不写 new 也不是 null：asy 隐式跑一次 operator init
P u;
write(u.x);

// 字段带默认值：**每次构造都重新求**（量过：`struct B { int n = bump(); }` 之后
// `new B` 两次，计数器是 2）。这一刀的前端没有文件级变量，所以这里用"默认值里印一行"
// 来看那件事 —— 每构造一次就多一行 mk。
int shout(int v) { write("mk"); return v; }
struct B { int n = shout(7); string s = "hi"; }
B b1 = new B;
B b2 = new B;
write(b1.n);
write(b2.n);
write(b1.s);

// 不写 new 的那种也照求默认值（asy 的隐式 operator init 就是 new B）
B b3;
write(b3.n);

// 字段进表达式与条件
if (p.x > 0) { write(p.x * 2); } else { write(-1); }

// 记录当形参、返回值，循环里造一串
P last = new P;
for (int i = 0; i < 3; ++i) {
  P e = new P;
  e.x = i * 10;
  last = e;
}
write(last.x);
