// 第五十七刀：匿名函数里，点号**左边**那个名字也可能是外层函数的局部量。
// 少了这一档时报的是"调用一个不是普通名字的东西"，话说得偏 —— 真正缺的是捕获。
// base 里 plain_arrows.asy:364 的 `arrowhead.arcsize(p)` 与 plain_picture.asy:1022 的
// `srcCopy.fit(…)` 都是这一格。

struct S {
  real k = 3;
  real f(real x) { return k * x; }
}
typedef real fn(real);

// 方法调用：接收者是外层的形参
fn mk(S s) {
  return new real(real x) { return s.f(x); };
}
S s;
write(mk(s)(4));

// 字段读：同一档（不是调用，走的也是 dotQual）
fn kx(S s) {
  return new real(real x) { return s.k + x; };
}
write(kx(s)(1));

// 接收者是外层的**局部**而不是形参；struct 是引用语义，所以闭包之后改它的字段
// 两边都看得见（asy 按引用捕获，我们按值抓那个引用 —— 这一格两种语义同一个结果）
fn kk() {
  S t;
  t.k = 5;
  fn g = new real(real x) { return t.f(x); };
  t.k = 7;
  return g;
}
write(kk()(2));
