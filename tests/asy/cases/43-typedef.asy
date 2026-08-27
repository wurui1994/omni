// typedef：别名，不造新类型。`graph_splinetype.asy` 的
// `typedef real[] splinetype(real[], real[]);` 就是这一条（量过：真 base 在场时
// 它是 examples 的第一名，143 份），所以函数类型的那一种是重点。

typedef int myint;
myint add(myint a, myint b) {return a+b;}
write(add(3, 4));

// 别名与原类型互通（不是新类型）
int plain(int x) {return x + 1;}
myint n = 7;
write(plain(n));

typedef real realfn(real);
real twice(real x) {return 2*x;}
real halve(real x) {return x/2;}
real apply(realfn f, real v) {return f(v);}
write(apply(twice, 5));
write(apply(halve, 5));

// 返回数组的函数类型 —— splinetype 的形状
typedef real[] mapfn(real[]);
real[] doubled(real[] xs) {
  real[] out;
  for (int i = 0; i < xs.length; ++i) out.push(2*xs[i]);
  return out;
}
real total(mapfn f, real[] xs) {
  real[] ys = f(xs);
  real s = 0;
  for (int i = 0; i < ys.length; ++i) s += ys[i];
  return s;
}
real[] xs = {1, 2, 3};
write(total(doubled, xs));

// 数组的别名
typedef int[] ints;
ints ns = {4, 5, 6};
write(ns.length);
write(ns[2]);

// struct 的别名
struct Box { int v; }
typedef Box Crate;
Crate c = new Box;
c.v = 11;
write(c.v);

// using 那个拼法（camp.y 里是另一条产生式，落到同一张别名表）
using mystr = string;
mystr s = "hi";
write(s + "!");

using rfn = real(real);
write(apply(twice, 1.5));

// 同一个名字再 typedef 一次：后面那份盖住前面那份
typedef int again;
again a1 = 1;
write(a1);
typedef string again;
again a2 = "two";
write(a2);

// 函数值类型的**变量**：经 typedef 的这个拼法是通的（裸的 `real f(real) = twice;`
// 那个拼法还在门外，bad/fn-value 钉着）。赋值换一个函数也通。
realfn h = twice;
write(h(6));
h = halve;
write(h(6));
