/* 第八刀第十二片：**stdout 是字节，不是字符**。
 *
 * C 这一条腿上一个「串」就是一串字节。到第十一片为止我们的输出把它当 JS 串按 UTF-8
 * 再编一遍，于是 `漢` 出去成了 6 个字节而不是 3 个 —— 一条 byte-exact 的轴上这是
 * 一个真的错。这份用例把三条路都量了：源文件里的非 ASCII 字面量、`putchar` 出去的
 * 高字节、`%c` 与 `fputs` 到 stderr。
 *
 * 退出码收在 0..255 里，所以下面只加小数。
 */
#include <stdio.h>
#include <string.h>

int main(void) {
  int s = 0;

  /* 源文件里的字面量：`sizeof` 数的是**字节**（UTF-8 的三个字节 + 结尾的 0） */
  printf("%s %d %d\n", "漢字", (int)sizeof("漢字"), (int)strlen("漢字"));
  s += (int)sizeof("漢字");                 /* 7 */

  /* 一个字节一个字节 putchar 出去，凑成同一个字（U+4E2D） */
  putchar(0xE4);
  putchar(0xB8);
  putchar(0xAD);
  putchar('\n');
  s += 3;                                   /* 10 */

  /* %c 拿到的是 int，收到 unsigned char 再出去 */
  printf("%c%c%c|\n", 0xC3, 0xA9, '!');
  s += 3;                                   /* 13 */

  /* %s 一路：高字节在串中间，`strlen` 与 `printf` 数出来的一样多 */
  {
    const char *p = "aé漢b";
    printf("%s %d\n", p, (int)strlen(p));
    s += (int)strlen(p);                    /* +7 = 20 */
  }

  /* 每个字节单独看：`char` 是**有符号**的（这个目标上），所以要收到 unsigned char
   * 才是那个字节的值。两条腿印出来必须一样。 */
  {
    const char *p = "é";
    int i;
    for (i = 0; p[i] != 0; i++) printf("%d ", (int)(unsigned char)p[i]);
    printf("\n");
    s += i;                                 /* +2 = 22 */
  }

  /* stderr 那条也是字节 */
  fputs("stderr: 漢字\n", stderr);
  fprintf(stderr, "%s|%c%c\n", "é", 0xE4, 0xB8);
  s += 3;                                   /* 25 */

  printf("s=%d\n", s);
  return s;
}
