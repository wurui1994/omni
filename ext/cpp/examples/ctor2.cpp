// 构造函数重载：**同一个类几份构造，按实参个数挑**。
//
// 名字按**实参个数**编（`Vec__ctor0` / `Vec__ctor2`），调用点数一数实参就定了哪一份 ——
// 于是它还是一格普通调用，图上一格新节点也没加。个数一样的两份当场报（那要按类型挑，
// 是另一件事）。
//
// 钉住五件事：默认构造（`Vec v;` 与 `Vec()` 两种写法都要走它）、带实参那一份、
// 一个实参那一份、构造里调另一格方法、以及**重载之间不许串味**（各自的成员初始化表分开）。
#include <stdio.h>

struct Vec {
  int x;
  int y;
  int n;
  Vec() : x(0), y(0) {
    n = tag();
  }
  Vec(int a) : x(a), y(a) {
    n = tag() + 1;
  }
  Vec(int a, int b) : x(a), y(b) {
    n = tag() + 2;
  }
  int tag() {
    return 100;
  }
  int sum() {
    return x + y;
  }
};

int main() {
  Vec a;
  printf("%d %d %d\n", a.x, a.y, a.n);
  Vec b(7);
  printf("%d %d %d\n", b.x, b.y, b.n);
  Vec c(3, 4);
  printf("%d %d %d\n", c.x, c.y, c.n);
  Vec d = Vec();
  printf("%d %d\n", d.sum(), d.n);
  Vec e = Vec(5, 6);
  printf("%d %d\n", e.sum(), e.n);
  return 0;
}
