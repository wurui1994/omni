// 纯虚（`= 0`）：**基类只说"有这个方法"，不给体**。
//
// 那一格没有体，所以分派函数的兜底不能再调根自己那一份（它不存在）。落法是
// **兜底换成 `(fail …)`** —— C++ 里抽象类根本造不出对象，所以那一支跑不到；
// 真跑到了就是我们自己算错了，那时候停下来比静默地答错强。
//
// 钉住四件事：纯虚方法只经派生类调、非纯虚的兄弟方法照旧、基类里**调自己的纯虚方法**
// （`describe` 里的 `area()` 走分派函数），以及"纯虚那一份不发体"（发了就会报重复定义）。
#include <stdio.h>

struct Shape {
  int w;
  virtual int area() = 0;
  int describe() {
    return area() + w;
  }
};

struct Square : Shape {
  int area() {
    return w * w;
  }
};

struct Rect : Shape {
  int h;
  int area() {
    return w * h;
  }
};

int total(Shape *a, Shape *b) {
  return a->area() + b->area();
}

int main() {
  Square q;
  q.w = 3;
  Rect r;
  r.w = 2;
  r.h = 5;
  printf("%d\n", q.area());
  printf("%d\n", r.area());
  printf("%d\n", q.describe());
  printf("%d\n", r.describe());
  printf("%d\n", total(&q, &r));
  return 0;
}
