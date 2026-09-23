// **方法按实参类型重载**：`add(int)` / `add(double)` / `add(int,int)` 三份同名。
//
// `methov.cpp` 那一族分的是**实参个数**，个数一样的两份从前当场报。现在名字分三档
// （见 `methodName`）：没重载的不动、重载但个数各不相同的缀个数、**有两份个数一样的
// 缀实参类型**（`Acc_add__int` / `Acc_add__real` / `Acc_add__int_int`）。挑那一份与
// 自由函数共用同一份 `pickAmong`（先找一模一样的，再看能提升的，剩正好一份才算）。
//
// 钉住三件事：从外头按类型调、**在方法体里裸写**着调（`both()` 里的 `add(1)` 与
// `add(2.0)`）、以及第三份靠个数分开而它自己体里又调了第一份（`add(a) + b`）。
#include <stdio.h>

struct Acc {
  int n;
  double r;
  int add(int x) {
    n = n + x;
    return n;
  }
  double add(double x) {
    r = r + x;
    return r;
  }
  int add(int a, int b) {
    return add(a) + b;
  }
  int both() {
    return add(1) + (int)add(2.0);
  }
  /* **重载 + 出参**：两份 `take` 个数一样、借的都是第一格 —— 有了这条共识就可以先建实参
     （那一格交盒子）再按类型挑那一份。外头调与体里裸写着调各钉一行。 */
  void take(int& out) {
    out = n;
  }
  void take(double& out) {
    out = r;
  }
  int sum() {
    int i = 0;
    double d = 0.0;
    take(i);
    take(d);
    return i + (int)d;
  }
};

int main() {
  Acc a;
  a.n = 0;
  a.r = 0.0;
  printf("%d\n", a.add(3));
  printf("%.2f\n", a.add(1.5));
  printf("%d\n", a.add(2, 10));
  printf("%d\n", a.both());
  int gi = 0;
  a.take(gi);
  double gd = 0.0;
  a.take(gd);
  printf("%d %.2f\n", gi, gd);
  printf("%d\n", a.sum());
  return 0;
}
