/* 第六刀第五片：外部符号、变参、libc。**这一份用例是 oracle 升级的分界**：
 * 从这里起 `tests/c/run.js` 不只比退出码，还比整条 stdout 逐字节。
 *
 * 原来这儿手写着十三行原型（「没有头文件」那句现在过时了）—— 第八刀第三片装上了
 * `<stdio.h>` / `<stdlib.h>` / `<string.h>` 的最小子集，于是三行 include 就够。
 * 不能拿 tcc 对账的两格不出现在这儿：`%p`（地址不同）与浮点（前端还没有）。 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

int main(void) {
  /* ---- 变参：实参个数每个调用点都不同，所以调用点直接发 CCALL */
  printf("hello %s, %d + %d = %d\n", "world", 2, 3, 2 + 3);
  printf("no args\n");
  printf("%d\n", 1);

  /* ---- 宽度、精度、标志 */
  printf("[%5d][%-5d][%05d][%+d][% d]\n", 42, 42, 42, 42, 42);
  printf("[%x][%X][%#x][%o][%#o]\n", 255, 255, 255, 8, 8);
  printf("[%c][%s][%.3s][%8.3s][%-8.3s]\n", 'A', "abcdef", "abcdef", "abcdef", "abcdef");
  printf("[%u][%ld][%lld][%zu]\n", 4294967295u, 1234567890123L, -1LL, sizeof(int));
  printf("[%*d][%.*d][%-*d]\n", 6, 7, 4, 7, 6, 7);
  printf("100%% done\n");

  /* ---- 长度修饰符：hh/h 在变参里已经被默认实参提升拉成 int */
  {
    char c = (char)200;
    short s = (short)-300;
    printf("[%hhd][%hd][%d][%d]\n", c, s, c, s);
  }

  /* ---- 非变参的外部函数：调用点照旧发 CALL，桩在读完整个单元之后才造 */
  printf("strlen=%lu\n", strlen("abcd"));
  printf("strcmp=%d %d %d\n", strcmp("abc", "abc"), strcmp("abc", "abd") < 0,
    strcmp("abd", "abc") > 0);

  char buf[64];
  strcpy(buf, "head");
  strcat(buf, "-tail");
  printf("buf=%s len=%lu\n", buf, strlen(buf));

  sprintf(buf, "%d/%s/%c", 7, "xy", 'z');
  printf("sprintf=%s\n", buf);

  {
    /* snprintf 回的是「本来会写多少」，不是「实际写了多少」（C11 7.21.6.5） */
    char small[4];
    int n = snprintf(small, 4, "abcdef");
    printf("snprintf=%d [%s]\n", n, small);
  }

  char a[8];
  char b[8];
  memset(a, 'x', 8);
  memcpy(b, a, 8);
  printf("memcmp=%d\n", memcmp(a, b, 8));
  b[3] = 'y';
  printf("memcmp2=%d\n", memcmp(a, b, 8) < 0);

  printf("abs=%d %d\n", abs(-7), abs(7));

  /* ---- 自己的函数与 libc 混在一起 */
  {
    int i;
    for (i = 0; i < 8; i++) printf("%d%s", fib(i), i == 7 ? "\n" : " ");
  }

  puts("via puts");
  putchar('z');
  putchar('\n');

  return (int)(strlen(buf) % 251);
}
