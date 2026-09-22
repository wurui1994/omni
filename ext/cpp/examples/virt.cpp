// 虚函数：**同一个调用点按对象的真身分派**。
//
// 那堵墙不在"新节点"，在**表示**：继承本来是摊平的，`Shape` 与 `Square` 是两格互不相关的
// 记录，所以 `Shape* p = &r;` 表示不出来。这一格换了一条：**一棵继承树合成一格记录**
// （根的名字、字段是整棵树的并集 + 一格 `__vt` 标记），派生类只是"同一格记录的另一种静态
// 类型"。于是：
//   * 非虚方法照旧**静态**分派（静态类型定哪一份 —— C++ 的隐藏规则）；
//   * 虚方法落成一格**分派函数**（`Shape__v_area`）—— 按 `__vt` 走 if 链，一格新节点也没加。
//
// 钉住五件事：直接调、基类指针收、`&x` 取地址（记录本来就是引用）、**非虚方法里调虚方法**
// （两个派生类各一行 —— 那一格走的是分派函数，不是静态的那一份），以及基类自己的对象
// 落到兜底那一支（`__vt` 是 0）。
#include <stdio.h>

struct Shape {
  int w;
  virtual int area() {
    return 0;
  }
  int twice() {
    return area() * 2;
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

int describe(Shape *s) {
  return s->area();
}

int main() {
  Square q;
  q.w = 3;
  Rect r;
  r.w = 2;
  r.h = 5;
  Shape b;
  b.w = 9;
  printf("%d\n", q.area());
  printf("%d\n", r.area());
  printf("%d\n", b.area());
  printf("%d\n", describe(&q));
  printf("%d\n", describe(&r));
  printf("%d\n", describe(&b));
  printf("%d\n", q.twice());
  printf("%d\n", r.twice());
  Shape *p = &r;
  printf("%d\n", p->area());
  return 0;
}
