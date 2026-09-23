// **构造函数按实参类型重载**：`Num(int)` / `Num(double)` / `Num(int,int)`。
//
// `ctor2.cpp` 那一族分的是实参**个数**，个数一样的两份从前当场报（"按实参类型挑那一档
// 还没接"）。现在构造的名字与方法同理分三档：个数各不相同的照旧缀个数（`Num__ctor2`），
// **有两份个数一样的那一档缀实参类型**（`Num__ctor1_int` / `Num__ctor1_real`）。
// 挑那一份与自由函数、方法**共用同一份 `pickAmong`**。
//
// 造对象那两处都接了：`Num b(1.5);`（声明那一格）与 `Num(0.25).dd()`（函数式的那一格）。
#include <stdio.h>

struct Num {
  int i;
  double d;
  Num(int v) : i(v), d(0.0) {
  }
  Num(double v) : i(0), d(v) {
  }
  Num(int a, int b) : i(a + b), d(0.0) {
  }
  /* **重载的构造 + 出参**：从前这一格当场报（"这个类只有一份构造"才接）。现在按
     `C.ctorCands` + 那条共识挑：收 3 个实参的只有这一份，借的是第一格。 */
  Num(int& seed, int a, int b) : i(a + b), d(0.0) {
    seed = seed + i;
  }
  int show() {
    return i;
  }
  double dd() {
    return d;
  }
};

int main() {
  Num a(5);
  Num b(1.5);
  Num c(2, 3);
  printf("%d\n", a.show());
  printf("%.2f\n", b.dd());
  printf("%d\n", c.show());
  printf("%d\n", Num(9).show());
  printf("%.2f\n", Num(0.25).dd());
  int seed = 1;
  Num e(seed, 4, 5);
  printf("%d %d\n", seed, e.show());
  return 0;
}
