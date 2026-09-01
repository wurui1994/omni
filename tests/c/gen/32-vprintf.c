/* 第八刀第六片：`vprintf` / `vsprintf` / `vsnprintf`。
 *
 * `va_list` 在这个目标上**就是**变参区的地址（`tccgen.js` 把 `__builtin_va_list`
 * 定成 `void *`），而 `cFormat` 拿的正是那个地址 —— 所以 `printf(fmt, ...)` 与
 * `vprintf(fmt, ap)` 在宿主那一层是同一件事。
 *
 * 要量的是**穿过一层函数调用**：变参区的地址从自家的变参函数里取出来，交给 libc，
 * 那边接着往下读。外加 `va_copy` 之后两条游标互不干扰。
 *
 * `<stdarg.h>` 得自己写上：`va_start` 那几个宏只在那一份里。我们的 `<stdio.h>` 顺带
 * 带进来了（它要 `va_list` 才能声明 `vprintf`），但 macOS 真正的那份只带类型不带宏 ——
 * 靠 stdio.h 转带就会在 tcc 那一侧编不过（量过：`implicit declaration of 'va_start'`）。
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 最常见的形状：自己包一层 printf */
static int say(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vprintf(fmt, ap);
  va_end(ap);
  return n;
}

/* 包一层 vsnprintf，回「本来会写多少」 */
static int fmtInto(char *buf, size_t cap, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, cap, fmt, ap);
  va_end(ap);
  return n;
}

/* 同一份实参走两遍：先量长度，再真的写进去 —— 这是 va_copy 的经典用法 */
static char *dup2fmt(const char *fmt, ...) {
  va_list ap;
  va_list ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  char *p = malloc((size_t)n + 1);
  vsprintf(p, fmt, ap2);
  va_end(ap2);
  return p;
}

/* 再套一层：ap 又往下传一次（vprintf 不是终点，穿两层也得对） */
static int relay(const char *fmt, va_list ap) {
  return vprintf(fmt, ap);
}

static int twoDeep(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = relay(fmt, ap);
  va_end(ap);
  return n;
}

int main(void) {
  int n = say("say %d %s %c\n", 7, "str", 'q');
  printf("saylen %d\n", n);

  char buf[8];
  memset(buf, '#', 8);
  int want = fmtInto(buf, 8, "%s-%d", "ab", 42);
  printf("into %d [%s]\n", want, buf);
  /* 截断：回的仍是「本来会写多少」 */
  memset(buf, '#', 8);
  want = fmtInto(buf, 4, "%s", "abcdefg");
  printf("cut %d [%s]\n", want, buf);
  /* cap = 0：一个字节都不写（buf 里那个 '#' 要还在） */
  memset(buf, '#', 8);
  want = fmtInto(buf, 0, "%d", 12345);
  printf("zero %d %d\n", want, buf[0]);

  char *p = dup2fmt("%s/%s/%d", "aa", "bbb", 99);
  printf("dup [%s] %d\n", p, (int)strlen(p));
  free(p);

  n = twoDeep("deep %d %f\n", 3, 0.5);
  printf("deeplen %d\n", n);

  /* 浮点与宽度也要能穿过去（走的是同一条游标） */
  say("wide [%8.3f] [%-6s] [%+d]\n", 2.25, "ab", 5);

  return (int)strlen("vfmt") + want % 7;
}
