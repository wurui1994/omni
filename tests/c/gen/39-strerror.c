/* 第八刀第十三片：`strerror` 与 `perror`。
 *
 * 那张号到文字的表整张都是从 oracle 上量出来的 —— 这份用例把其中一部分逐字节对上，
 * 顺带量了两条**指针**上的性质（macOS 上量的）：
 *   - 同一个号两次调用回同一个地址，不同的号回不同的地址，先拿到的那个串不会被
 *     后来的调用改掉（那是一张常量表）；
 *   - 表**外**的号（`Unknown error: N`）共用一格 —— 先拿到的那个指针会跟着变。
 */
#include <stdio.h>
#include <string.h>
#include <errno.h>

int main(void) {
  int s = 0;

  /* 几个我们真的会设的号 */
  printf("%s\n", strerror(0));
  printf("%s\n", strerror(ENOENT));
  printf("%s\n", strerror(EACCES));
  printf("%s\n", strerror(ERANGE));
  printf("%s\n", strerror(EDOM));
  s += 5;                                     /* 5 */

  /* 表最后一格与表外 */
  printf("%s|%s\n", strerror(107), strerror(108));
  s += 2;                                     /* 7 */

  /* 负号也是表外 */
  printf("%s\n", strerror(-1));
  s += 1;                                     /* 8 */

  /* 长度：最长的那句 46 个字符 */
  printf("len=%d\n", (int)strlen(strerror(47)));
  s += (int)strlen(strerror(47)) / 46;        /* 9 */

  /* 一号一格：两次同号是同一个地址，不同号是不同地址 */
  {
    char *a = strerror(1);
    char *b = strerror(1);
    char *c = strerror(2);
    printf("same=%d diff=%d\n", a == b, a != c);
    s += (a == b) + (a != c);                 /* 11 */
    /* 先拿到的那个串没被后来的调用改掉 */
    printf("[%s][%s]\n", a, c);
    s += (strcmp(a, "Operation not permitted") == 0);  /* 12 */
  }

  /* 表外共用一格：先拿到的那个指针跟着变 */
  {
    char *a = strerror(500);
    char *b = strerror(501);
    printf("unk same=%d [%s][%s]\n", a == b, a, b);
    s += (a == b);                            /* 13 */
  }

  /* errno 是这张表的常客 */
  errno = EEXIST;
  printf("errno: %s\n", strerror(errno));
  s += 1;                                     /* 14 */

  /* perror：往 stderr 写 `前缀: 那句话` */
  errno = ENOENT;
  perror("open");
  errno = EACCES;
  perror("");                                 /* 空串：只写那句话 */
  errno = 0;
  perror("zero");
  s += 3;                                     /* 17 */

  printf("s=%d\n", s);
  return s;
}
