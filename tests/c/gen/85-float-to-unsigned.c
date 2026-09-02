/* 浮点 -> **无符号**整数（第九刀第九十五片）。
 *
 * 硬件那条「转成有符号」的指令（`fcvtzs` / `cvttsd2si`）在越界处是**饱和**的，
 * 所以无符号目标不能借它：`(unsigned)3000000000.0` 会得 `0x7fffffff`、
 * `(unsigned long long)9223372036854775808.0` 会得 `0x7fff…`。
 *
 * `volatile` 是为了不让它变成编译期常量折叠 —— 要称的是**发出来的指令**。
 */
#include <stdio.h>

int main(void) {
  volatile double a = 3000000000.0;          /* 装得进 u32，装不进 i32 */
  volatile double b = 9223372036854775808.0; /* 正好 2^63 */
  volatile double c = 18446744073709549568.0;/* u64 装得下的最大的那个 double */
  volatile double d = 1.75;                  /* 朝零截尾 */
  volatile float g = 3000000000.0f;
  volatile float h = 9223372036854775808.0f;
  volatile double e = 40000.5;                /* 装得进 u16，装不进 i16 */
  printf("%u %u\n", (unsigned)a, (unsigned)g);
  printf("%llu %llu %llu\n", (unsigned long long)b, (unsigned long long)c,
    (unsigned long long)d);
  printf("%llu\n", (unsigned long long)h);
  /* 窄的那两个都得**装得下** —— 装不下在 C 里是未定义行为（C11 6.3.1.4 第 1 段），
   * 而尺子那边越界是饱和的（`fcvtzu` 给 0xffffffff 再按位与），拿 UB 当用例
   * 只会量出两边谁更巧。 */
  printf("%hu %hhu\n", (unsigned short)e, (unsigned char)d);
  /* 有符号那一侧一个字都不该变 */
  printf("%d %lld\n", (int)d, (long long)(-d));
  return 0;
}
