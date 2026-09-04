/* 与 bench/fib.omni **同一个算法**（ADR-0013 的执行路径对照）。
 *
 * 两处要对齐的地方：
 *   - `sumTo` 的累加器是 64 位（omni 的 `int` 就是 i64），所以 `i * i` 也得先升到
 *     `long long` —— 拿 `int` 乘会在 i > 46341 时溢出，那就不是同一个算法了。
 *   - 输出必须与别的路**逐字节相同**（对照测试的本体是「答案一样」，耗时只是顺手记的）。
 */
#include <stdio.h>

int fib(int n) {
  if (n < 2) { return n; }
  return fib(n - 1) + fib(n - 2);
}

long long sumTo(int n) {
  long long acc = 0;
  for (int i = 1; i <= n; i++) { acc += (long long)i * i % 1000003; }
  return acc;
}

int main(void) {
  printf("%d\n", fib(27));
  printf("%lld\n", sumTo(2000000));
  return 0;
}
