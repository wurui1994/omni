// 函数模板：**单态化**（一格实参类型一份函数）。
//
// 落法与 nim/V 的泛型那一路同一条：模板本身**不发代码**，调用点按实参的静态类型
// 算出一份实例名（`maxOf__int` / `maxOf__real`），第一次见到就把体降一遍。
// 图上一格新节点也没加 —— 落的全是现成的 `fn` + `call`。
//
// 钉住四件事：
//   1. 同一个模板两种实参类型 ⇒ **两份函数**（int 那份与 double 那份互不影响）；
//   2. 模板里调模板（`sum3` 调 `maxOf`）—— 实例化要能套；
//   3. **显式写出实参**（`maxOf<double>(1, 2)`）—— 那一格不看实参类型，看写着的那个；
//   4. 模板里的 `T` 当**局部量的类型**用（不只是形参）。
#include <stdio.h>

template <class T>
T maxOf(T a, T b) {
  T r = a;
  if (b > r) {
    r = b;
  }
  return r;
}

template <class T>
T sum3(T a, T b, T c) {
  T m = maxOf(a, b);
  return m + c;
}

int main() {
  printf("%d\n", maxOf(3, 7));
  printf("%d\n", maxOf(9, 2));
  printf("%g\n", maxOf(1.5, 0.25));
  printf("%d\n", sum3(1, 2, 3));
  printf("%g\n", sum3(0.5, 1.5, 2.0));
  printf("%g\n", maxOf<double>(4.0, 2.5));
  return 0;
}
