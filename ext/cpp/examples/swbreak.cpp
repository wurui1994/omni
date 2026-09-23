// **`switch`**（cpp 这一门自己的形状：**穿透**，要 `break` 才断）。
//
// 落公共层现成的那一格（它摊成 if/else 链）。**两处与 C++ 不一样，要认清**：
//   1. 公共层那一格每支各自独立，而 C++ 不写 `break` 就往下掉 —— 所以每组末尾那句
//      `break` 要**摘掉**（它的意思是"出 switch"，而公共层的 `break` 是"出循环"，
//      留着就跳错了）；**没有 `break`/`return` 又不是最后一支**的当场报，
//      别静默地把穿透改成不穿透。
//   2. 树上每格 `case` 只带**一条**语句（`(case v stmt)`），剩下的是它后面的兄弟 ——
//      所以要自己按 `case` / `default` 分组；而 `case 2: case 3:` 在树上是**套起来的**
//      （一格 case 的"那条语句"又是一格 case），那是"两个值共用一份体"，摊成两格。
//
// 与 go 那一族 `switch` 不是同一个程序（go 的 `switch {}` 无值形与 `case 2, 3` 多值形
// C++ 写不出来），所以另起一个家族名。
//
// 钉住五件事：单值、**两个值共用一份体**、`default`、`return` 当出口（不用 break）、
// 以及 `break` 那一档（改一格量再断）。
#include <stdio.h>

int kind(int n) {
  switch (n) {
    case 1:
      return 10;
    case 2:
    case 3:
      return 20;
    default:
      return 30;
  }
}

int main() {
  printf("%d\n", kind(1));
  printf("%d\n", kind(2));
  printf("%d\n", kind(3));
  printf("%d\n", kind(9));
  int k = 2;
  int hit = 0;
  switch (k) {
    case 1:
      hit = 1;
      break;
    case 2:
      hit = 2;
      break;
    default:
      hit = 9;
  }
  printf("%d\n", hit);
  return 0;
}
