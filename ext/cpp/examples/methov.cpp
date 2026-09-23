// 方法重载：**同一个类几份同名方法，按实参个数挑**。
//
// 与构造函数那一格同一条路：重载的那几份名字后头缀上实参个数（`Acc_add__0` /
// `Acc_add__1` / `Acc_add__2`），**没重载的还叫老名字**（`Acc_get`）—— 所以已有的那几族
// 一个字节都不动。调用点数一数实参就定了哪一份，图上一格新节点也没加。
//
// 改这一格之前：三份 `add` 都发成 `Acc_add`，方言当场报"重复定义"（不是静默地错，
// 但三份声明只有一份能活）。
//
// 钉住四件事：不带实参那一份、一个实参那一份、两个实参那一份、以及**方法体里裸写的
// 重载调用**（`bump` 里的 `add(d)` 要挑到一个实参那一份）。
#include <stdio.h>

struct Acc {
  int v;
  void add() {
    v = v + 1;
  }
  void add(int d) {
    v = v + d;
  }
  void add(int d, int e) {
    v = v + d + e;
  }
  int bump(int d) {
    add(d);
    return v;
  }
  int get() {
    return v;
  }
};

int main() {
  Acc a;
  a.v = 0;
  a.add();
  printf("%d\n", a.get());
  a.add(5);
  printf("%d\n", a.get());
  a.add(2, 3);
  printf("%d\n", a.get());
  printf("%d\n", a.bump(4));
  return 0;
}
