/* 真的 macOS 系统头（第八刀第十六片）。
 *
 * 到这一片之前，`#include <stdio.h>` 拿到的是 `src/include/` 里我们自己那份最小
 * 子集。这一份用例不给我们任何优待：`-I <SDK>/usr/include`，两条腿读的是**同一份**
 * `/usr/include`（tcc 自己就默认读那儿）。
 *
 * 它证明的不是「printf 对」——那早证过了；它证明的是「那套头文件我们能读进来」：
 * `__attribute__` 一整套、`__asm("_name")` 改名、`extern char *sys_errlist[]` 那种
 * 不完整的 extern 数组、`__uint128_t`，以及「声明了几百个函数但只引用了六个」。
 *
 * 不碰 `stdout`/`stderr`：SDK 里它们是 `extern FILE *__stdoutp`，那要「外部全局量」
 * 与 `FILE` 的真布局，还没到。 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>

int main(void) {
  char *p = malloc(32);
  strcpy(p, "abc");
  printf("%s %d\n", p, (int)strlen(p));
  int a = 0, b = 0;
  sscanf("7 9", "%d %d", &a, &b);
  printf("%d\n", a + b);
  printf("%s\n", strerror(2));
  free(p);
  return (int)strlen("abcdefghij") + a + b;
}
