/* 第八刀第三片：libc 的自述 —— 三份头，一行手写声明都没有。
 *
 * 这份用例的意义不在算什么，而在**它编得过**：从第五片起每份 gen/ 用例头上都得手写
 * 一行 `int printf(const char *fmt, ...);`，从这一片起 `#include <stdio.h>` 就够了。
 *
 * oracle 那一侧 tcc 用的是 macOS 真正的头（它把 `<stdio.h>` 转手给系统），
 * 我们用的是自带的那三份 —— 两边的原型必须**兼容**，逐字节对账正是在验这一句。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  /* ---- stdio.h：输出的那几条 */
  puts("hello");
  putchar('x');
  putchar('\n');
  printf("%d %s %c %u\n", -7, "str", 'q', 4000000000u);

  char buf[64];
  int n = sprintf(buf, "%s=%d", "k", 42);
  printf("sprintf %d [%s]\n", n, buf);
  /* snprintf 回的是「本来会写多少」，不是「实际写了多少」 */
  int m = snprintf(buf, 4, "%s", "abcdefg");
  printf("snprintf %d [%s]\n", m, buf);
  printf("eof %d\n", EOF);

  /* ---- stdlib.h：堆与那两个绝对值 */
  char *p = malloc(16);
  strcpy(p, "heap");
  strcat(p, "!");
  printf("heap %s %d\n", p, (int)strlen(p));
  p = realloc(p, 64);
  strcat(p, "grown");
  printf("grown %s\n", p);
  free(p);

  int *z = calloc(4, sizeof(int));
  printf("calloc %d %d\n", z[0], z[3]);
  free(z);
  printf("abs %d %ld\n", abs(-9), labs(-1234567890123L));
  printf("exitcodes %d %d\n", EXIT_SUCCESS, EXIT_FAILURE);

  /* ---- string.h：那几条 mem/str */
  char a[8];
  char b[8];
  memset(a, 'A', 8);
  memcpy(b, a, 8);
  printf("memcmp %d\n", memcmp(a, b, 8));
  b[3] = 'B';
  printf("memcmp2 %d\n", memcmp(a, b, 8) < 0);
  /* 重叠着往后挪一格 */
  char ov[8];
  memcpy(ov, "abcdefg", 8);
  memmove(ov + 1, ov, 6);
  ov[7] = 0;
  printf("memmove %s\n", ov);
  printf("strcmp %d %d\n", strcmp("a", "a"), strcmp("a", "b") < 0);

  char *d = strdup("dup");
  printf("strdup %s %d\n", d, (int)strlen(d));
  free(d);

  /* NULL 来自 stddef.h，被上面三份头各自带进来一次 —— 守卫得管住 */
  printf("null %d\n", (void *)0 == NULL);

  return (int)strlen("hello") + abs(-11) + (int)sizeof(size_t);
}
