/* 第一百五十三片：**带 `U` 的十进制常量是 `unsigned int`，不是 `unsigned long long`**
 * （C11 6.4.4.1 表 1：先试 `unsigned int`，装得下就是它）。
 *
 * 从前这一格的 32 位上限两种情形都拿 `0x7fffffff` 比，于是 `3141592653U` 成了
 * `unsigned long long`，`3141592653U * key` 跟着变成 **64 位乘法不回绕** ——
 * 编得过、也不报错，**答案错**。R 的 `src/main/unique.c` 里的散列就是这个形状：
 *
 *     static hlen scatter(unsigned int key, HashData *d)
 *     { return 3141592653U * key >> (32 - d->K); }
 *
 * 于是 `duplicated(c(1,2,2))` 在 JS 那条腿上读到表外（`memory access out of bounds`），
 * 整数那一路更坏：下标落在表外但还在内存里 —— 静默答错。
 *
 * 判据照这一组的规矩：与 cc 编出来的**逐字节相同**（printf 的每个字节 + 退出码）。 */

#include <stdio.h>

static unsigned int scatter(unsigned int key, int K) {
  return 3141592653U * key >> (32 - K);
}

int main(void) {
  /* sizeof 直接把类型说出来：`unsigned int` 的 4，不是 `unsigned long long` 的 8 */
  printf("%d %d %d\n", (int) sizeof(3141592653U), (int) sizeof(4294967295U),
         (int) sizeof(4294967296U));                    /* 4 4 8 */
  /* 4294967295U + 1U 在 u32 上回绕成 0；成了 u64 就是 4294967296 */
  printf("%u\n", 4294967295U + 1U);                     /* 0 */
  /* 散列那一格：key 大到让乘积越出 32 位时，回绕与不回绕差得很远 */
  printf("%u %u %u\n", scatter(1, 10), scatter(2, 10), scatter(1072693248U, 10));
  /* union 里按位换个眼光看 double（R 的 rhash 就是这么取 double 的两半） */
  union { double d; unsigned int u[2]; } f;
  f.d = 1.0;
  printf("%u %u %u\n", f.u[0], f.u[1], f.u[0] + f.u[1]);
  printf("%u\n", scatter(f.u[0] + f.u[1], 10));
  /* 十六进制那一路本来就该更早跳到无符号；顺手钉住 */
  printf("%d %d\n", (int) sizeof(0xffffffff), (int) sizeof(0x100000000));  /* 4 8 */
  return 0;
}
