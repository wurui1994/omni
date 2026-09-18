/* 调用那一半（见 `abi.h`）。每一行都是「造一个 struct 回来（返回值那条路）」套
 * 「按值传进去（实参那条路）」—— 一行同时压两条规则。 */
#include "abi.h"
int printf(const char *, ...);

int main(void) {
  printf("%lld\n", take8(mk8(7)));
  printf("%lld\n", take16(mk16(3, 4)));
  printf("%lld\n", take24(mk24(1, 2, 3)));
  printf("%.1f\n", takeD2(mkD2(1.5, 2.25)));
  printf("%.1f\n", takeF3(mkF3(1, 2, 3)));
  printf("%lld\n", takeI12(mkI12(5, 6, 7)));
  printf("%lld\n", takeC5(mkC5(2, 9)));
  printf("%lld\n", mix(1, mk16(2, 3), 4.0, mkD2(5, 6), mk24(7, 8, 9), 10));
  /* 变参那一格（见 abi.h 第九条）：两趟 —— 一趟的第二趟能顺带按住"游标推得对不对"。 */
  printf("%lld\n", vamix(1, mk24(1, 2, 3), mk16(4, 5), 6.0, mkD2(7, 8), 9));
  printf("%lld\n", vamix(2, mk24(1, 2, 3), mk16(4, 5), 6.0, mkD2(7, 8), 9,
    mk24(2, 3, 4), mk16(5, 6), 7.0, mkD2(8, 9), 1));
  return 0;
}
