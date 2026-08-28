// 第六十二刀：同名的变量遮住了函数名，而那个位置要的是一个**函数类型** ——
// asy 里名字是按签名查的，由目标类型定案。原型是 plain_picture.asy:428 的
// `void userBoxX3(real min, real max, binop m=min, binop M=max)`。

private using binop = real(real, real);

// 形参 `real min` 就在默认值那段的作用域里，可它不是 binop，所以默认值取的是**函数** min
struct S {
  void m(real min, real max, binop f = min, binop g = max) {
    write(f(min, max));
    write(g(min, max));
  }
  void bare() { m(3, 7); }
}
S s;
s.bare();
s.m(3, 7);
// 显式给了实参时不受这一条影响
s.m(3, 7, max, min);

// 文件级也是同一条：局部量遮住函数名，目标类型是函数类型时查到函数
void top(real min, real max) {
  binop f = min;
  write(f(min, max));
  write(min);
}
top(1, 2);

// 变量的初值、赋值、return 三处共用 coerce，所以都通
binop h;
real abs2(real x, real y) { return x * x + y * y; }
binop pick(real abs2) { return abs2; }
h = pick(1);
write(h(3, 4));
