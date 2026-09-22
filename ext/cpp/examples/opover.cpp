// 运算符重载：`operator+` / `operator-` / `operator==` / `operator[]`（成员那一档）。
//
// 落法是**改写成一次调用**：`a + b` 里 a 是有 `operator+` 的类 → `(call Vec2_op_add a b)`。
// 名字按算符编（`op_add` / `op_sub` / `op_eq` / `op_index`），与普通方法同一条命名
// （`类名_方法名`），所以分派、登记、体的发射一格都不用另写。
//
// 钉住四件事：二元算术、相等（交 bool）、下标（交元素）、以及**内建的那一档不许被抢**
// （`int + int` 还是方言的 `+`，不是调用）。
#include <stdio.h>

struct Vec2 {
  int x;
  int y;
  Vec2 operator+(Vec2 o) {
    Vec2 r;
    r.x = x + o.x;
    r.y = y + o.y;
    return r;
  }
  Vec2 operator-(Vec2 o) {
    Vec2 r;
    r.x = x - o.x;
    r.y = y - o.y;
    return r;
  }
  bool operator==(Vec2 o) { return x == o.x && y == o.y; }
  int operator[](int i) { return i == 0 ? x : y; }
};

int main() {
  Vec2 a;
  a.x = 1;
  a.y = 2;
  Vec2 b;
  b.x = 10;
  b.y = 20;
  Vec2 c = a + b;
  printf("%d\n", c.x);
  printf("%d\n", c.y);
  Vec2 d = b - a;
  printf("%d\n", d.x);
  printf("%d\n", d.y);
  Vec2 e;
  e.x = 11;
  e.y = 22;
  printf("%d\n", c == e);
  printf("%d\n", c == a);
  printf("%d\n", a[0]);
  printf("%d\n", a[1]);
  // 内建的那一档照旧是方言的算子（不是调用）
  int m = 3;
  int n = 4;
  printf("%d\n", m + n);
  return 0;
}
