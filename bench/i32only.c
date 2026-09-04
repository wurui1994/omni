/* 第三份对照程序（ADR-0013 第二刀）：**纯 i32**，一处 `long long` 都没有。
 *
 * 它的身份是那一刀的**净口径**：i32 从 BigInt 换成 JS number，收益在这份上是纯的
 * （604 ms -> 26 ms，23 倍）。而 `fib.c` 那份混着 i64，每次 `(long long)i * i` 都要
 * 装一次箱，所以那份反而慢了 —— 两份摆在一起，这一刀的形状才是完整的。
 *
 * 循环体里那两条是有意选的：`i * 3` 要 32 位乘法（`Math.imul`），`>>`/`^` 要位运算，
 * 而 `acc` 会溢出回绕 —— 都是「i32 语义」里容易被写错的那几格。
 */
#include <stdio.h>

int main(void) {
  int acc = 0;
  for (int i = 1; i <= 20000000; i++) {
    acc += i * 3 - (i >> 2);
    acc ^= acc >> 7;
  }
  printf("%d\n", acc);
  return 0;
}
