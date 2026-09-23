// **自由函数的重载（按实参类型）**：`int mix(int)` / `double mix(double)` /
// `int mix(int,int)` / `int mix(P)` 四份同名。
//
// 从前这一格是**第五次"覆盖 vs 追加"**：四份都发成一个名字 `mix`，方言报的是 `.sx` 里的
// "重复定义"，而且第一份的签名赢了，第二份的体照第一份的类型去检 —— 报出来的第二条错
// （"`*` 两边要同型"）根本不是病因。
//
// 落法与方法那一格同一条规矩的两半：**没重载的名字一个字节不动**、重载了的按实参类型
// 缀名字（`mix__int` / `mix__real` / `mix__int_int` / `mix__P`）。挑那一份照 C++ 的次序：
// 先找逐格类型一模一样的，没有再看"每格都能提升过去"的（这条腿只认 `int -> double`
// 与 `bool -> int`），剩下**正好一份**才算，不然当场报。
//
// 最后一行钉住**提升**那一档：`mix(true)` 在 C++ 里挑 `int` 那份（`bool -> int`）。
#include <stdio.h>

struct P {
  int x;
};

int mix(int a) {
  return a * 2;
}

double mix(double a) {
  return a * 3;
}

int mix(int a, int b) {
  return a + b;
}

int mix(P p) {
  return p.x + 100;
}

int main() {
  printf("%d\n", mix(4));
  printf("%.2f\n", mix(1.5));
  printf("%d\n", mix(2, 3));
  P p;
  p.x = 7;
  printf("%d\n", mix(p));
  double d = 2.0;
  printf("%.2f\n", mix(d));
  printf("%d\n", mix(true));
  return 0;
}
