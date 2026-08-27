// 非 void 的 `operator init`：asy 收这个**声明**（它就是个名字古怪的方法），只是不给
// `A(…)` 构造调用 —— 量过写了 `A a = A(3);` 之后报 "no matching variable 'A'"。
// 我们连声明一起拒：`operator init` 在我们这里只有一种形态（void 的那份，见
// cases/23-ctor.asy）。所以这一条是"还没做"，带 ASY_NOPE。
struct A {
  int x;
  int operator init(int v) { x = v; return 7; }
}
A a;
write(a.x);
