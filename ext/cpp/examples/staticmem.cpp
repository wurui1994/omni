// **`static` 数据成员**：一个类**一份**，不是每个对象各一份。
//
// 从前这一格**答案静默地错**：`static` 在 specs 里当修饰被丢掉，于是
// `static const int LIMIT = 10;` 变成一格**每个对象各一份的零值字段** ——
// `LIMIT - n` 算出来是 `-n`（我们印 -3，`c++` 印 7）。这是"声明符/说明符上的修饰有没有
// 人看"那个形状的第七次（`T&` 那一格是第六次）。
//
// 落法：`static` 成员发成一格**模块级的量**（公共层现成的 `{ kind: 'global' }`，
// 名字是 `类名__成员名`）。方言的 `(global 名字 类型)` 不带初值（按设计零初始化），
// 所以非零的初值摆在 `main` 体的最前面 —— C++ 里 static 也是 main 之前就初始化好的。
//
// 钉住六件事：类里给初值的（`LIMIT`）、类外给初值的（`int Counter::total = 0;`）、
// 方法体里裸写着改它（一个类一份 —— 两个对象一起数）、`Counter::total` 那种写法，
// 以及**`static` 成员函数**：从外头 `Counter::make(5)` 调、里头裸写着调另一格 static。
#include <stdio.h>

struct Box {
  static const int LIMIT = 10;
  int n;
  int room() {
    return LIMIT - n;
  }
};

struct Counter {
  static int total;
  int n;
  void add() {
    n = n + 1;
    total = total + 1;
  }
  /* **`static` 成员函数**：没有 `this`，就是一格普通函数（名字 `类名__名字`）——
     但 `static` 数据成员与别的 static 成员函数照样看得见（`C.statCls` 那一格）。 */
  static int nextId() {
    total = total + 1;
    return total;
  }
  static Counter make(int v) {
    Counter x;
    x.n = v + nextId();
    return x;
  }
};

int Counter::total = 100;

int main() {
  Box b;
  b.n = 3;
  printf("%d\n", b.room());
  Counter a;
  a.n = 0;
  Counter c;
  c.n = 0;
  a.add();
  a.add();
  c.add();
  printf("%d\n", a.n);
  printf("%d\n", c.n);
  printf("%d\n", Counter::total);
  Counter::total = 7;
  printf("%d\n", Counter::total);
  Counter d = Counter::make(5);
  printf("%d\n", d.n);
  printf("%d\n", Counter::total);
  return 0;
}
