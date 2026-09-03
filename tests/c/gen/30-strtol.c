/* 第八刀第四片：`strtol` 一族 + `strncpy` / `strchr` / `strstr` 那几条。
 *
 * 选它们的理由不是「顺着标准往下抄」，是 tinycc 的源码在用。
 * 这一份钉的多半是**边角**：`strncpy` 什么时候不补 0、`strncat` 的 n 是谁的 n、
 * `strchr(s, 0)` 回哪儿、`strtol` 的 endptr 在一位有效数字都没有时指哪儿。
 *
 * 溢出的输入不出现在这儿：C 说那时要设 `errno = ERANGE`，而我们还没有 errno
 * （见 src/include/stdlib.h 头上那一节）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  /* ---- atoi / atol */
  printf("atoi %d %d %d %d\n", atoi("42"), atoi("-42"), atoi("  +7abc"), atoi("x9"));
  printf("atol %ld\n", atol("-1234567890123"));

  /* ---- strtol：base、endptr、前缀 */
  char *e;
  long v = strtol("1234rest", &e, 10);
  printf("dec %ld [%s]\n", v, e);
  v = strtol("0x1fZ", &e, 16);
  printf("hex %ld [%s]\n", v, e);
  v = strtol("0x1f", &e, 0);
  printf("auto16 %ld %d\n", v, *e == 0);
  v = strtol("017", &e, 0);
  printf("auto8 %ld %d\n", v, *e == 0);
  v = strtol("19", &e, 0);
  printf("auto10 %ld %d\n", v, *e == 0);
  v = strtol("  -0755", &e, 8);
  printf("oct %ld %d\n", v, *e == 0);
  v = strtol("zz", &e, 36);
  printf("base36 %ld %d\n", v, *e == 0);
  /* 一位有效数字都没有：回 0，endptr 指回**原地址** */
  const char *bad = "hello";
  v = strtol(bad, &e, 10);
  printf("none %ld %d\n", v, e == bad);
  /* `0x` 后面不是十六进制位：那个 `0` 算数，endptr 停在 `x` 上 */
  v = strtol("0xz", &e, 16);
  printf("stub %ld [%s]\n", v, e);
  /* endptr 给 NULL 是合法的 */
  printf("noend %ld\n", strtol("55", NULL, 10));

  /* ---- strtoul：负号也是合法的（按无符号取负） */
  printf("ul %lu\n", strtoul("4294967295", NULL, 10));
  printf("ulneg %d\n", strtoul("-1", NULL, 10) == 18446744073709551615UL);

  /* ---- strncpy：源短了用 0 填满 n，源长了不补 0 */
  char d[8];
  memset(d, '#', 8);
  strncpy(d, "ab", 5);
  printf("ncpy %d %d %d %d\n", d[0], d[2], d[4], d[5]);
  memset(d, '#', 8);
  strncpy(d, "abcdefgh", 4);
  printf("ncpy2 %d %d\n", d[3], d[4]);

  /* ---- strncat：n 只管从源那边取几个，终止的 0 不算 */
  char c[16];
  strcpy(c, "ab");
  strncat(c, "cdef", 2);
  printf("ncat [%s] %d\n", c, (int)strlen(c));

  /* ---- strncmp：回字节差，遇到 0 就停 */
  printf("ncmp %d %d %d\n",
    strncmp("abc", "abd", 2), strncmp("abc", "abd", 3) < 0, strncmp("ab", "ab", 9));

  /* ---- strchr / strrchr：0 也算这个字符串的一部分 */
  const char *s = "a/b/c";
  printf("chr %d %d\n", (int)(strchr(s, '/') - s), (int)(strrchr(s, '/') - s));
  printf("chr0 %d %d\n", (int)(strchr(s, 0) - s), strchr(s, 'z') == NULL);

  /* ---- strstr：空的针在最前面 */
  const char *h = "aXbXc";
  printf("str %d %d %d\n",
    (int)(strstr(h, "Xb") - h), (int)(strstr(h, "") - h), strstr(h, "Xz") == NULL);

  return atoi("11") + (int)strtol("22", NULL, 10) + (int)(strchr(s, 'c') - s);
}
