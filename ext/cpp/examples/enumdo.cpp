// **`enum` / `enum class` 与 `do … while`** —— C 那一族里两格很常用、这条腿上一直没接的东西。
//
// 1. **枚举子是常量**（C++ 的规矩），所以这条腿上**不发模块级的量**：枚举名落成 `int` 的
//    别名，读到枚举子那一格直接换成字面量。值按 C++ 数 —— 从 0 起，写了 `= N` 就从 N 接着数。
//    `enum class` 的枚举子要写全名（`Mode::On`），所以两把钥匙都进表（`RED` 与 `Color::RED`）。
//
// 2. **`do 体 while (条件);`**：体**先跑一趟**。摊成"一格旗子 + 普通 while"：
//      let __do1 = true;  while (__do1 || 条件) { __do1 = false; 体 }
//    两条路都试过、都是错的：
//      * "永真循环 + 末尾 `if (!条件) break`" —— 体里的 `continue` 会跳过那句检查，
//        而 C++ 里 do-while 的 `continue` 是**跳到条件那一句**（轻则少判一次，重则死循环）；
//      * "体 + while(条件){体}" —— 体发两份，副作用跟着来两遍。
//    `||` 在方言里是短路的，所以第一趟不会去求那个条件。
//
// 钉住七件事：默认从 0 数、`= 5` 之后接着数、枚举当变量的类型、`enum class` 写全名、
// 枚举在 switch 里当值用、do-while 体先跑一趟（条件一上来就假）、**do-while 里的 continue**。
#include <stdio.h>

enum Color { RED, GREEN = 5, BLUE };

enum class Mode { Off, On = 3 };

int pick(int m) {
  switch (m) {
    case 0:
      return 10;
    case 3:
      return 30;
    default:
      return 20;
  }
}

int main() {
  printf("%d %d %d\n", (int)RED, (int)GREEN, (int)BLUE);
  Color c = BLUE;
  printf("%d\n", (int)c);
  Mode m = Mode::On;
  printf("%d %d\n", (int)m, pick((int)m));
  /* 条件一上来就假 —— 体还是跑了一趟。 */
  int n = 9;
  int runs = 0;
  do {
    runs = runs + 1;
    n = n + 1;
  } while (n < 5);
  printf("%d %d\n", runs, n);
  /* do-while 里的 `continue`：跳到**条件那一句**，不是跳回体的开头。 */
  int i = 0;
  int s = 0;
  do {
    i = i + 1;
    if (i == 2) {
      continue;
    }
    s = s + i;
  } while (i < 5);
  printf("%d %d\n", i, s);
  return 0;
}
