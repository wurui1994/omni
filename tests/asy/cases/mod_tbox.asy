// 模板模块（`typedef import(…)`）。被 54-template-mod.asy 实例化两次：T=int 与 T=string。
typedef import(T);

write('tbox 体跑了一遍');

struct Box_T {
  T v;
  void operator init(T v) { this.v = v; }
  T get() { return this.v; }
}

// 文件级变量：每个实例一块**自己的**存储（量过 asy 就是这样）
int calls = 0;

T first(T a, T b) { ++calls; return a; }
int hits() { return calls; }
