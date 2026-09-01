/* 第八刀第十四片：`sscanf` / `vsscanf` / `fscanf`。
 *
 * 每一条的期望值都是从 `tcc -run` 上量出来的 —— 尤其是「回 0 还是回 EOF」那一条：
 * `sscanf("", "%d", &a)` 是 -1（输入先没了），`sscanf("abc", "%d", &a)` 是 0
 * （匹配失败）。这两个差一个字，而 `while (sscanf(...) == 1)` 那种循环两种都能收，
 * `if (sscanf(...) != EOF)` 就不行。
 */
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

/* `vsscanf` 与 `sscanf` 在这一层是同一个东西 —— va_list 就是变参区的地址 */
static int wrap(const char *s, const char *fmt, ...) {
  va_list ap;
  int r;
  va_start(ap, fmt);
  r = vsscanf(s, fmt, ap);
  va_end(ap);
  return r;
}

int main(void) {
  int a = -1, b = -1, n = -1;
  char s[32];
  char c = '?';
  long L = -1;
  unsigned u = 0;
  double d = -1;
  float f = -1;
  int t = 0;

  printf("1: %d %d %d\n", sscanf("12 34", "%d %d", &a, &b), a, b);
  a = b = -1; printf("2: %d %d %d\n", sscanf("12", "%d %d", &a, &b), a, b);
  a = -1; printf("3: %d %d\n", sscanf("", "%d", &a), a);
  a = -1; printf("4: %d %d\n", sscanf("abc", "%d", &a), a);
  a = -1; printf("5: %d %d\n", sscanf("  \t\n 42", "%d", &a), a);
  a = b = -1; printf("6: %d %d %d\n", sscanf("1234", "%2d%2d", &a, &b), a, b);
  a = -1; printf("7: %d %d\n", sscanf("7 8", "%*d %d", &a), a);
  s[0] = 0; printf("8: %d [%s]\n", sscanf("  hello world", "%s", s), s);
  s[0] = 0; printf("9: %d [%s]\n", sscanf("hello", "%3s", s), s);
  c = '?'; printf("10: %d [%c]\n", sscanf(" x", "%c", &c), c);
  c = '?'; printf("11: %d [%c]\n", sscanf(" x", " %c", &c), c);
  a = -1; printf("12: %d %d\n", sscanf("ff", "%x", &a), a);
  a = -1; printf("13: %d %d\n", sscanf("17", "%o", &a), a);
  a = -1; printf("14: %d %d\n", sscanf("0x1f", "%i", &a), a);
  u = 0; printf("15: %d %u\n", sscanf("4294967295", "%u", &u), u);
  L = -1; printf("16: %d %ld\n", sscanf("9999999999", "%ld", &L), L);
  d = -1; printf("17: %d %.3f\n", sscanf("3.5e1", "%lf", &d), d);
  f = -1; printf("18: %d %.3f\n", sscanf("2.25", "%f", &f), (double)f);
  a = b = -1; printf("19: %d %d %d\n", sscanf("3,4", "%d,%d", &a, &b), a, b);
  a = b = -1; printf("20: %d %d %d\n", sscanf("3;4", "%d,%d", &a, &b), a, b);
  a = -1; n = -1; printf("21: %d %d %d\n", sscanf("42abc", "%d%n", &a, &n), a, n);
  a = -1; printf("22: %d %d\n", sscanf("-5", "%d", &a), a);
  a = -1; printf("23: %d %d\n", sscanf("5x", "%d", &a), a);
  a = -1; printf("24: %d %d\n", sscanf("  ", "%d", &a), a);
  s[0] = 0; printf("25: %d [%s]\n", sscanf("", "%s", s), s);
  a = -1; printf("26: %d %d\n", sscanf("  12", "  %d", &a), a);
  a = -1; printf("27: %d %d\n", sscanf("12", "%%%d", &a), a);
  a = -1; printf("28: %d %d\n", sscanf("%12", "%%%d", &a), a);
  t += 28;

  /* 窄的与宽的：`%hd` 收到 short，`%lld` 是 long long */
  {
    short h = -1;
    long long q = -1;
    printf("29: %d %d\n", sscanf("32767", "%hd", &h), (int)h);
    printf("30: %d %lld\n", sscanf("123456789012", "%lld", &q), q);
    t += 2;
  }

  /* 一个格式串里三种转换 + 字面量 */
  {
    int y = 0, m = 0, dd = 0;
    printf("31: %d %d-%d-%d\n", sscanf("2026-09-01", "%d-%d-%d", &y, &m, &dd), y, m, dd);
    t += 1;
  }

  /* vsscanf 与 sscanf 是同一个东西 */
  a = b = -1;
  printf("32: %d %d %d\n", wrap("8 9", "%d %d", &a, &b), a, b);
  t += 1;

  /* fscanf：输入是一条流，游标只推过真的用掉的那些字节 */
  {
    const char *path = "/tmp/omni-c-gen40.txt";
    FILE *w = fopen(path, "w");
    if (w == NULL) return 100;
    fputs("11 22\n3.5 xyz\n", w);
    fclose(w);
    FILE *r = fopen(path, "r");
    if (r == NULL) return 101;
    a = b = -1;
    printf("33: %d %d %d\n", fscanf(r, "%d %d", &a, &b), a, b);
    d = -1; s[0] = 0;
    printf("34: %d %.3f [%s]\n", fscanf(r, "%lf %s", &d, s), d, s);
    a = -1;
    printf("35: %d\n", fscanf(r, "%d", &a));
    fclose(r);
    remove(path);
    t += 3;
  }

  printf("t=%d\n", t);
  return t;
}
