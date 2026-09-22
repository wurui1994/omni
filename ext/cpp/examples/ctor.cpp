// 构造函数：**成员初始化表 + 体**，落成一格造记录的函数。
//
// 落法是 `Point__ctor(a, b)` —— 先造一格零值记录，按**声明的次序**跑成员初始化表
// （C++ 的规矩：次序看字段的声明，不看初始化表里写的次序），再跑体，最后交出去。
// 调用点三种写法（`Point p(1,2)` / `Point p = Point(1,2)` / `return Point(1,2)`）
// 落的是同一格 `call` —— 图上一格新节点也没加。
//
// 钉住五件事：带实参的声明、函数式写法、**次序按声明**、**默认构造**（不带实参那一格
// 还是零值 + 体）、以及构造函数里能调自己的方法。
#include <stdio.h>

struct Point {
  int x;
  int y;
  int sum;
  Point(int a, int b) : y(b), x(a) {
    sum = total();
  }
  int total() { return x + y; }
};

struct Counter {
  int n;
  Counter() {
    n = 100;
  }
};

Point shifted(int d) {
  return Point(d, d + 1);
}

int main() {
  Point p(1, 2);
  printf("%d\n", p.x);
  printf("%d\n", p.y);
  printf("%d\n", p.sum);
  Point q = Point(10, 20);
  printf("%d\n", q.sum);
  Counter c;
  printf("%d\n", c.n);
  Point r = shifted(5);
  printf("%d\n", r.x);
  printf("%d\n", r.sum);
  return 0;
}
