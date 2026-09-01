/* 边界：`case` 标签长在里层的控制结构里 —— 真的 Duff's device。
 *
 * 第二十五片让语句标签与 `case` 的段界摆在同一串嵌套 `BLOCK` 上，但两者都要求标签是
 * 那个复合语句的**直接子语句**：一处段界 = 一层 `BLOCK`。`case 3:` 长在 `do` 的循环体
 * 里，它不是 switch 函数体的直接子语句，于是没有自己的段界（`openSegs` 当场数出来
 * 段界比扫到的 case 少）。要做的话得让「进入一个 case」也走状态机那一路
 * （case 也编个号，与语句标签同一套分派）—— 那是独立的一件事。
 * C 允许（`case` 的作用域是整个 switch 体），所以这是我们的边界，不是错误。 */
int main(void) {
  int n = 2;
  int t = 0;
  switch (n % 4) {
  case 0:
    do {
      t += 1000;
  case 3:
      t += 100;
  case 2:
      t += 10;
  case 1:
      t += 1;
    } while (0);
  }
  return t;
}
