// **`for (T v : xs)`** —— 按值在列表上走一遍（C++11 的区间 for）。
//
// 公共层那格 `for-range` 要一份**语言钩子**（"在什么上走一遍"各门语言答得不一样），
// 而这一门的答案就是"下标从 0 到 `alen`" —— 所以直接摊成三段式的 `for`，不再加一层。
// 那格量是**拷出来的**（元素是记录就走 `类名__copy`），`for (T& v : xs)` 当场报。
//
// 顺带补上一格运行期崩：**元素是记录的数组要把格子填上**（`P ps[2];` —— `anew` 开出来的
// 格子是 null，`ps[0].x = 1` 报 "null reference"；C++ 那边两个子对象是现成的）。
//
// 钉住五件事：写着类型的、`auto` 的、**记录元素按值走**（改 `p` 改不到列表里那一格）、
// `continue` / `break` 照常、以及走完之后列表本身没变。
#include <stdio.h>

struct P {
  int x;
};

int main() {
  int xs[3] = {10, 20, 30};
  int s = 0;
  for (int v : xs) {
    s = s + v;
  }
  printf("%d\n", s);
  int t = 0;
  for (auto v : xs) {
    t = t + v * 2;
  }
  printf("%d\n", t);
  P ps[2];
  ps[0].x = 1;
  ps[1].x = 2;
  for (P p : ps) {
    p.x = p.x + 100;
  }
  printf("%d %d\n", ps[0].x, ps[1].x);
  int u = 0;
  for (int v : xs) {
    if (v == 20) {
      continue;
    }
    if (v == 30) {
      break;
    }
    u = u + v;
  }
  printf("%d\n", u);
  printf("%d\n", xs[1]);
  return 0;
}
