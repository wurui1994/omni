/* 第八刀第七片：`<ctype.h>`。
 *
 * 十三条一行的函数，但有三处容易错：
 *   1. 收的是 `int`，`EOF`（-1）是**合法输入** —— 先转 `unsigned char` 就会把它
 *      变成 255（`ÿ`），于是 `isprint(EOF)` 莫名为真。
 *   2. 回的只保证非零。这一份用例照 C 的保证写（`!= 0`），不比具体的数 ——
 *      glibc 回的是位掩码（2048 那类），macOS 回 1，两台机器上这份用例都成立。
 *   3. `toupper`/`tolower` 对不认识的输入**原样回**，包括 `EOF`。这两条的**返回值**
 *      是有定义的，所以照实比。
 */
#include <stdio.h>
#include <ctype.h>
#include <string.h>

/* 一条谓词在一小串代表性字符上的结果，收成一个位串印出来 */
static void row(const char *name, int (*p)(int)) {
  const char *s = "aZ0 \t\n!~";
  printf("%s", name);
  for (int i = 0; s[i] != 0; i++) printf(" %d", p((unsigned char)s[i]) != 0);
  /* 三个边角：EOF、0、127 */
  printf(" | %d %d %d\n", p(EOF) != 0, p(0) != 0, p(127) != 0);
}

int main(void) {
  row("alpha", isalpha);
  row("digit", isdigit);
  row("alnum", isalnum);
  row("space", isspace);
  row("upper", isupper);
  row("lower", islower);
  row("xdigi", isxdigit);
  row("punct", ispunct);
  row("print", isprint);
  row("graph", isgraph);
  row("cntrl", iscntrl);

  /* toupper / tolower：字母换、别的原样、EOF 原样 */
  printf("up %d %d %d %d\n", toupper('a'), toupper('Z'), toupper('0'), toupper(EOF));
  printf("down %d %d %d %d\n", tolower('A'), tolower('z'), tolower('!'), tolower(EOF));

  /* 拿它们做一件真事：就地把一个串换成大写，再数一遍数字 */
  char buf[16];
  strcpy(buf, "ab7C-9z");
  int digits = 0;
  for (int i = 0; buf[i] != 0; i++) {
    if (isdigit((unsigned char)buf[i])) digits++;
    buf[i] = (char)toupper((unsigned char)buf[i]);
  }
  printf("work [%s] %d\n", buf, digits);

  return digits + (int)strlen(buf) + (isalpha('q') != 0);
}
