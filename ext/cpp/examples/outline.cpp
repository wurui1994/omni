// **体写在类外**：`int Counter::bump() { … }`。真实 C++ 里这是常态（类在头文件、体在
// `.cpp`），从前这一格当场报，而且**语法上根本过不去** —— `int bump();` 有两份解析：
// 一格函数声明，一格"默认造一格 bump"（`(d (n bump) (ctor (args)))`）。后者在 C++ 里
// 不合法（`T x();` 是函数声明，不是默认构造），所以那是**语法写松了**：`init-declarator`
// 里那条 `(declarator "(" args ")")` 的实参串不许空。改成 `arg-list` 之后这一句只有
// 一份解析，歧义没了。
//
// adapter 那半是一趟扫顶层：声明符的名字是 `(qual (n 类) (n 成员))` 的那几格搬回类里，
// 后面几遍（摊平、重载编名、签名、发体）一个字都不用改。
//
// 钉住五件事：普通方法、构造函数（带成员初始化表）、析构函数、`operator+`，
// 以及**虚方法的覆盖**也写在类外。
#include <stdio.h>

struct Counter {
  int n;
  Counter(int start);
  ~Counter();
  int bump();
  int get() {
    return n;
  }
};

Counter::Counter(int start) : n(start) {
}

Counter::~Counter() {
  printf("~Counter %d\n", n);
}

int Counter::bump() {
  n = n + 1;
  return n;
}

struct Vec2 {
  int x;
  int y;
  Vec2(int a, int b);
  Vec2 operator+(Vec2 o);
  int sum();
};

Vec2::Vec2(int a, int b) : x(a), y(b) {
}

Vec2 Vec2::operator+(Vec2 o) {
  Vec2 r(x + o.x, y + o.y);
  return r;
}

int Vec2::sum() {
  return x + y;
}

struct Shape {
  int w;
  virtual int area();
  int twice() {
    return area() * 2;
  }
};

struct Sq : Shape {
  int area();
};

int Shape::area() {
  return w;
}

int Sq::area() {
  return w * w;
}

int main() {
  Counter c(10);
  printf("%d\n", c.bump());
  printf("%d\n", c.get());
  Vec2 a(1, 2);
  Vec2 b(30, 40);
  Vec2 s = a + b;
  printf("%d\n", s.sum());
  Sq q;
  q.w = 4;
  printf("%d\n", q.twice());
  Shape d;
  d.w = 7;
  printf("%d\n", d.twice());
  return 0;
}
