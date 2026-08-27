// 函数类型的形参：`real f(real)` 写在形参表里，调用点 `f(v)` 是间接调用。
// 真 base 里 math.asy:446 的 `real findroot(real f(real), …)` 就是这一条 ——
// 量过：304 个 examples 里 203 个第一个撞的是它。

real twice(real x) {return 2*x;}
real half(real x) {return x/2;}

real apply(real f(real), real v) {return f(v);}

write(apply(twice, 3));
write(apply(half, 3));

// 形参里的函数值再往下传一层
real twice2(real f(real), real v) {return apply(f, apply(f, v));}
write(twice2(twice, 1));
write(twice2(half, 8));

// 多个形参、以及 void 返回
int add(int a, int b) {return a+b;}
int fold3(int f(int,int), int a, int b, int c) {return f(f(a,b),c);}
write(fold3(add, 1, 2, 3));

void say(string s) {write("say " + s);}
void run(void f(string), string s) {f(s);}
run(say, "hi");

// 循环里反复间接调用
real sum(real f(real), int n) {
  real s = 0;
  for (int i = 1; i <= n; ++i) s += f(i);
  return s;
}
write(sum(twice, 4));
write(sum(half, 4));
