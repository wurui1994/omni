/* `unsigned long long` -> 浮点（第九刀第九十四片）。
 *
 * x86 没有「无符号 64 位 -> 浮点」这条指令：`cvtsi2sd` 认的是有符号的，v >= 2^63
 * 会被算成负数。所以那一路要分两半，而分法必须**正确舍入** —— 值挑的就是这个：
 * 2^63 前后、末位带信息的、以及 double 与 float 的有效位边界（2^53、2^24）。
 * 尺子是 clang（`tests/c/native.js`）。
 */
#include <stdio.h>

int main(void) {
  unsigned long long vs[] = {
    0ULL, 1ULL, 3ULL, 12345ULL,
    (1ULL << 24) + 1, (1ULL << 53) + 1,
    (1ULL << 62) + 7,
    1ULL << 63,
    (1ULL << 63) + 1,
    (1ULL << 63) + 1024,
    0xfffffffffffff800ULL,
    0xffffffffffffffffULL,
  };
  for (int k = 0; k < 12; k++) {
    double d = (double)vs[k];
    float g = (float)vs[k];
    printf("%d %.17g %.9g\n", k, d, (double)g);
  }
  /* 反方向（`(unsigned long long)(double)…`）是**另一件事**：那条路上 MIR 只有
   * 「浮点 -> 有符号整数」一种，2^63 以上会饱和 —— 第九十五片的题目，不在这儿称。 */
  return 0;
}
