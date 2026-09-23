// **记录是值语义**（C++ 的 struct 按值传、按值赋就是拷一份）。
//
// 从前这一格**答案静默地错**：方言的记录是引用语义，于是
//   * `grow(a)` 在里头改 `p.x` **改到了调用者那一格**（我们 101、`c++` 1）；
//   * `P b = a;` 之后 `b.x = 42` 把 `a.x` 也改了（我们 "42 42"、`c++` "1 42"）。
//
// 落法：给用到这条路的记录发一份 `类名__copy`（逐字段，字段本身是记录就再递归拷一层），
// 三处插进去 —— ①**被调方进门第一句**把按值收的记录形参拷一份（落在被调方而不是八九个
// 调用点上：少八处就少八处漏）；②`P b = a;`；③`b = a;`。
// 不拷的两格是有意的：**接收者**（`this` —— C++ 里方法本来就作用在那个对象上）与
// **借出去的形参**（`T&` / `T*`，那一格的意义就是要改到调用者那一格）。
//
// 钉住六件事：按值改不到调用者、拷贝初始化、拷贝赋值、方法的按值形参、**嵌套记录也拷**、
// 以及"方法改 this 确实改得动那个对象"（受这一刀影响最容易反过来错的一格）。
#include <stdio.h>

struct Inner {
  int v;
};

struct P {
  int x;
  Inner in;
  void bump() {
    x = x + 1;
  }
  int sumWith(P o) {
    o.x = o.x + 1000;
    return x + o.x;
  }
};

void grow(P p) {
  p.x = p.x + 100;
  p.in.v = p.in.v + 100;
}

int main() {
  P a;
  a.x = 1;
  a.in.v = 5;
  grow(a);
  printf("%d %d\n", a.x, a.in.v);
  P b = a;
  b.x = 42;
  b.in.v = 43;
  printf("%d %d %d %d\n", a.x, a.in.v, b.x, b.in.v);
  P c;
  c.x = 7;
  c.in.v = 8;
  c = a;
  c.x = 9;
  printf("%d %d\n", a.x, c.x);
  printf("%d\n", a.sumWith(b));
  printf("%d\n", b.x);
  a.bump();
  printf("%d\n", a.x);
  return 0;
}
