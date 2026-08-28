// 第六十二刀：`autounravel` 的成员跟着**类型**一起被 access 过去。
// 被 134-access-autounravel.asy 用（那边只 access `Box` 与 `Wrap`，而下面这些 autounravel
// 的名字要跟着来 —— collections/iter.asy 的 `Iterable` 与那一对 cast/ecast 就是这个形状）。

struct Box {
  int x;
  void operator init(int x) { this.x = x; }
  // 构造函数当函数值：名字不跟着改名走
  autounravel Box mkBox(int x) = Box;
  autounravel int twice(Box b) { return 2 * b.x; }
  // 一格 autounravel 的字段（与 static 同一格，只是文件级也裸着可见）
  autounravel int made = 0;
  // 转换：它不挂在名字上，按"提到了这个类型"认
  autounravel Box operator cast(int n) { return Box(n + 1); }
  autounravel int operator ecast(Box b) { return b.x * 100; }
}

struct Wrap {
  Box b;
  void operator init(Box b) { this.b = b; }
  autounravel Wrap operator cast(Box b) = Wrap;
}
