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

// 函数值类型的**变量**：形参表跟在名字后面这个拼法（量过：`import graph;` 那 193 条错
// 里有 4 条是它）。赋值换一个函数也通。
real g(real) = twice;
write(g(9));
g = half;
write(g(9));

// 函数里的局部函数值变量
real pick(bool up, real v) {
  real k(real) = twice;
  if (!up) k = half;
  return k(v);
}
write(pick(true, 7));
write(pick(false, 7));

// 有多个重载的名字当**实参**用：是哪一份由"这个槽要什么类型"定案（asy 就是这么定的，
// 量过 useI/useR 那两句在真 asy 那边是 7 与 12）。量出来的理由：内建面加了
// `add(frame,frame)` 之后，上面 `fold3(add,1,2,3)` 的 add 就是一个两份的重载集了。
int both(int a, int b) {return a + b;}
real both(real a, real b) {return a * b;}
int useI(int f(int,int)) {return f(3, 4);}
real useR(real f(real,real)) {return f(3, 4);}
write(useI(both));
write(useR(both));

// 传给函数值形参、再间接调用（期望类型是形参那一格的函数类型）
real callit(real f(real,real), real a, real b) {return f(a, b);}
write(callit(both, 2, 5));
