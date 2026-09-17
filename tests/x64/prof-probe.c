/* profiler 那三档的探子（第一百四十七片）。**自己判自己**：一行一格 ok / FAIL。
 *
 * 判什么：一份「热函数占九成」的程序，profiler 该把那个函数排在第一。这是 profiler
 * 唯一值得判的性质 —— 数字本身每次跑都不一样，而**谁在榜首**是确定的。
 *
 * 两档各判一遍：
 *   cc     ：编译器插桩（`-finstrument-functions`），比的是自用时间
 *   sample ：定时器 + backtrace，比的是帧数
 * 两档都要求：榜首是 `hot`、而且 `cold` 的份额明显小（10 倍以上）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void omni_prof_sample_start(int hz);

/* 两个函数，工作量差一个数量级。别让编译器把它们优化掉：结果要用出去。 */
static double sink = 0.0;

__attribute__((noinline)) static double hot(int n) {
  double a = 0.0;
  for (int i = 0; i < n; i++) a += (double)(i % 7) * 1.5;
  sink += a;         /* 强制副作用：sink 是全局的，编译器不敢把这一格内联掉 */
  return a;
}

__attribute__((noinline)) static double cold(int n) {
  double a = 0.0;
  for (int i = 0; i < n; i++) a += (double)(i % 3);
  sink += a;
  return a;
}

int main(int argc, char **argv) {
  int sampling = argc > 1 && strcmp(argv[1], "sample") == 0;
  if (sampling) omni_prof_sample_start(997);
  /* 九成的时间落在 hot 上。加大工作量让采样帧数够多（> 50 帧 hot 才有统计意义）。 */
  for (int r = 0; r < 2000; r++) {
    sink += hot(200000);
    sink += cold(2000);
  }
  printf("sink=%.1f\n", sink);
  return 0;
}
