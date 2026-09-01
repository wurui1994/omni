/* 第八刀第十一片：`int main(int argc, char **argv)`。
 *
 * 两条腿的命令行**摆法不同**（`tcc -B … -run <路径>` 对 `node cli.js c-run <路径>`），
 * 可 `argv` 那一段是一样的：argc 是 1，argv[0] 是命令行上写的那个源文件名，
 * argv[1] 是 NULL。所以这份用例只印**从 argv[0] 推出来的事实**（长度非零、以
 * "37-argv.c" 结尾），不印那个路径本身 —— 印它的话两条腿都会印同一个绝对路径，
 * 对得上，但这份用例就跟着机器走了。
 *
 * argv 那几个串还必须是**可改的**（C11 5.1.2.2.1 第 2 段），这也在下面量。
 */
#include <stdio.h>
#include <string.h>

static int ends_with(const char *s, const char *suf) {
  size_t n = strlen(s);
  size_t m = strlen(suf);
  if (m > n) return 0;
  return strcmp(s + n - m, suf) == 0;
}

int main(int argc, char **argv) {
  int s = 0;

  printf("argc=%d\n", argc);
  s += argc;                                  /* 1 */

  /* argv 本身不是空指针，argv[0] 也不是 */
  printf("argv!=0 %d argv[0]!=0 %d\n", argv != 0, argv[0] != 0);
  s += (argv != 0) + (argv[0] != 0);          /* +2 = 3 */

  /* argv[argc] 是 NULL —— 从 tcc 上量出来的 */
  printf("argv[argc]==0 %d\n", argv[argc] == 0);
  s += (argv[argc] == 0);                     /* +1 = 4 */

  /* argv[0] 是那个源文件名 */
  printf("len>0 %d ends %d\n", strlen(argv[0]) > 0, ends_with(argv[0], "37-argv.c"));
  s += (strlen(argv[0]) > 0) + ends_with(argv[0], "37-argv.c");  /* +2 = 6 */

  /* 遍历一遍：一个都不缺，而且每个都以 0 收尾（strlen 走得通） */
  {
    int i;
    size_t tot = 0;
    for (i = 0; i < argc; i++) tot += strlen(argv[i]);
    printf("total>0 %d\n", tot > 0);
    s += (tot > 0);                           /* +1 = 7 */
  }
  /* 指针走法与下标走法是同一件事 */
  {
    char **p = argv;
    int n = 0;
    while (*p != 0) { n++; p++; }
    printf("walk=%d\n", n);
    s += n;                                   /* +1 = 8 */
  }

  /* argv 的那几个串是**可改的** —— 改回去再比，两次都要对得上 */
  {
    char c = argv[0][0];
    argv[0][0] = 'Z';
    printf("mut=%c\n", argv[0][0]);
    s += (argv[0][0] == 'Z');                 /* +1 = 9 */
    argv[0][0] = c;
    printf("back %d\n", ends_with(argv[0], "37-argv.c"));
    s += ends_with(argv[0], "37-argv.c");     /* +1 = 10 */
  }

  /* argv 自己是个可改的左值（形参就是局部量） */
  {
    char **save = argv;
    argv = argv + 1;
    printf("bump %d\n", *argv == 0);
    s += (*argv == 0);                        /* +1 = 11 */
    argv = save;
    printf("restore %d\n", argv[0] != 0);
    s += (argv[0] != 0);                      /* +1 = 12 */
  }

  /* argc 同样 */
  argc += 30;
  printf("argc2=%d\n", argc);
  s += argc / 31;                             /* +1 = 13 */

  printf("s=%d\n", s);
  return s;
}
