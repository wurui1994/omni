// lambda：**按值捕获**那一档，落成公共层现成的闭包（`(cfn …)` + `(mkclo …)` + `(cap …)`）。
//
// 这一格一个新节点都没加 —— 公共降级器本来就有"闭包"这一格（ADR-0044 §1.2 的
// `{ kind: 'closure' }` 与 `make-closure` / `capture`），go 的匿名函数走的就是它。
// 这一门要做的只有三样：把 `(lambda …)` 读成参数表 + 捕获表 + 体、**返回类型从体里的
// `return` 推**、以及"局部量里装着函数就按值调"（`call-value`）。
//
// 钉住五件事：不捕获、具名捕获、`[=]` 全捕、**按值捕获之后改原来那格量不影响闭包**
// （那是最容易静默地错的一处），以及**捕获闭包**（`compose` 借走另外两格 lambda）。
#include <stdio.h>

int main() {
  auto add = [](int a, int b) {
    return a + b;
  };
  printf("%d\n", add(2, 3));
  int base = 10;
  auto bump = [base](int x) {
    return x + base;
  };
  printf("%d\n", bump(5));
  printf("%d\n", bump(7));
  base = 100;
  printf("%d\n", bump(5));
  int k = 3;
  auto scale = [=](int x) {
    return x * k;
  };
  printf("%d\n", scale(4));
  auto compose = [bump, scale](int x) {
    return bump(scale(x));
  };
  printf("%d\n", compose(2));
  /* **按引用捕获**（`[&n]` / `[&]`）：改得动外头那一格。落法与出参同一台机器 ——
     那格量装进一格盒子，闭包按值捕**盒子**（记录本来就是引用）。 */
  int n = 1;
  auto grow = [&n](int d) {
    n = n + d;
    return n;
  };
  printf("%d\n", grow(2));
  printf("%d\n", n);
  int sum = 0;
  auto acc = [&](int v) {
    sum = sum + v;
  };
  acc(5);
  acc(7);
  printf("%d\n", sum);
  return 0;
}
