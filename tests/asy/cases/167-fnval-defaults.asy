// 函数型变量的默认实参跟着**被赋进来那个函数**走，不是类型上那一份（第八十七刀）。
// asy 那边默认值是被调方填的（application.h:76 的 defaultArg 在调用处压一个
// push_default 记号，runtime.in:276 的 pushDefault 在被调方换成真值），所以
// `real H(real x, real y=0)=h;` 里那个 `y=0` **不参与** —— `H(1)` 补的是 h 自己的 0.5。
// 原型是 examples/splitpatch.asy 的
//   `triple[][][] Split(triple[][] P, real u=0)=depth % 2 == 0 ? hsplit : vsplit;`
// （hsplit/vsplit 自己的默认是 0.5，按类型那一份补会切在 0 上，切出退化的一行/一列）。
real h(real x, real y=0.5) { return y; }
real g(real x, real y=0.5) { return y + 100; }
int d=2;

void t() {
  // (1) 一个名字直接赋进来
  real H(real x, real y=0)=h;
  write(H(1));
  write(H(1, 7));

  // (2) `?:` 两支都是具名函数，而且这一格的默认值一样 —— 照样认
  real K(real x, real y=0)= d % 2 == 0 ? h : g;
  write(K(1));
  real K2(real x, real y=0)= d % 2 == 1 ? h : g;
  write(K2(1));
}
t();

// (3) 文件级那一格同样跟着被赋的函数走（记在它自己那条 gvar 记录上，不在作用域里）
real FH(real x, real y=0)=h;
write(FH(1));
real FK(real x, real y=0)= d % 2 == 0 ? h : g;
write(FK(1));

// 顺带量清的一件事（**不**写成用例，因为 asy 拒、我们收）：被赋进来的函数**自己没有**
// 默认值时，asy 那边少给实参是运行时错 —— `real M(real x, real y=0)=
// new real(real a, real b){return b+1000;}; M(1);` 报 `Trying to use uninitialized
// value`，指的正是那一格默认值。也就是说类型上写的 `y=0` 只是类型的一部分，
// **不当默认值使**；我们那时会退回类型那一份、印 1000，属于"比 asy 多收一门语言"。
