// 继承：**基类的字段与方法归派生类**（单继承、不带虚函数）。
//
// 落法是**摊平**：派生类的字段表 = 基类的字段接在前面（C++ 的布局也是这样），
// 基类的方法在派生类上按同一个名字再登记一格（接收者的类型换成派生类）。
// 为什么不给方言加"基类"那一格：方言的记录只有一张字段表，而摊平之后
// `d.base_field` 与 `d.own_field` 在同一格记录上 —— 三条腿一格都不用改。
//
// 钉住的四件事：基类字段读得到、基类字段写得动、**基类的方法在派生类上调得动**、
// 派生类自己那格方法与基类同名时**派生类那一份赢**（C++ 的隐藏规则）。
#include <stdio.h>

struct Base {
  int a;
  int b;
  int sum() { return a + b; }
  int tag() { return 1; }
};

struct Derived : Base {
  int c;
  int total() { return sum() + c; }
  int tag() { return 2; }
};

int main() {
  Derived d;
  d.a = 3;
  d.b = 4;
  d.c = 5;
  printf("%d\n", d.a + d.b);
  printf("%d\n", d.sum());
  printf("%d\n", d.total());
  printf("%d\n", d.tag());
  Base bb;
  bb.a = 10;
  bb.b = 20;
  printf("%d\n", bb.sum());
  printf("%d\n", bb.tag());
  return 0;
}
