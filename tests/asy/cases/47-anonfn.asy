// 匿名函数（`new T(形参){体}`）：降成顶层的 `(cfn …)`，用的地方是 `(mkclo …)`。
//
// 量出来的理由：`import graph;` 那 187 条诊断里 18 条是 `new`（graph.asy 里 `ticks`、
// `axis`、`Label` 那一族全靠它返回函数值），plain_filldraw 的 filltype 也是。
//
// 期望值都是 `asy -noV` 量的。**捕获**这一条与 asy 有一处收窄：asy 的捕获是按引用的
// （量过 `int k=1; int f()=new int(){return k;}; k=2; write(f());` 印 2），我们的
// `(mkclo …)` 按值抓一次，所以外层名字被赋值过的情况这一刀不收 —— 见 bad/anon-capref。
// 文件级的名字不在这一条里：它本来就是活读的。

// 不捕获任何东西
int f(int) = new int(int x) {return x * 3;};
write(f(4));

// 捕获外层函数的局部量（那个局部量在函数里没有被再赋值过）
int g(int n) {
  int m = n + 1;
  int h(int) = new int(int x) {return x + m;};
  return h(10);
}
write(g(5));

// 捕获文件级的名字（不进捕获表，跟 asy 一样是活读的）
int k = 7;
real apply(real f(real), real v) {return f(v);}
write(apply(new real(real x) {return x + k;}, 1));

// void 返回，而且同一个闭包调两次
void twice(void f(int), int v) {f(v); f(v);}
twice(new void(int x) {write(x * 2);}, 3);

// 体里有控制流；形参不止一个
int fold(int f(int,int), int a, int b, int c) {return f(f(a, b), c);}
write(fold(new int(int a, int b) {if (a > b) return a; return b;}, 3, 9, 5));

// 返回数组的匿名函数
int[] mk(int[] f(int), int n) {return f(n);}
write(mk(new int[](int n) {
  int[] a;
  for (int i = 0; i < n; ++i) a.push(i * i);
  return a;
}, 4).length);

// 循环里造闭包：捕获按值抓，所以每个闭包拿到的是自己那一份（量过下面印 0 1 2）。
// 这里用形参接而不是 `void p() = …`：那个拼法是**返回 void 的函数值变量**，
// 声明那一层还报"void 变量"（另一件事，与匿名函数无关）。
void call(void f()) {f();}
void each(int n) {
  for (int i = 0; i < n; ++i) {
    int j = i;
    call(new void() {write(j);});
  }
}
each(3);
