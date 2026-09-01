/* 第八刀第二十四片：`strtod` 一族。编出来的 tinycc 用 `strtold` 读源码里的浮点
 * 字面量，所以这一格是「产物逐字节相同」的前提 —— 同一串字符必须给出同一个 double。
 *
 * 十进制那一支交给宿主的 `Number()`（与本机的 `strtod` 一样正确舍入）；
 * 十六进制那一支（C99 起合法的 `0x1.8p3`）宿主不认，自己算。 */
#include <stdio.h>
#include <stdlib.h>

static void one(const char *s) {
  char *end;
  double v = strtod(s, &end);
  printf("[%s] -> %.17g used=%d\n", s, v, (int)(end - s));
}

int main(void) {
  int sum = 0;

  one("1.5");
  one("  -2.25e3xyz");
  one("0.1");
  one("3.14159265358979323846");
  one("1e308");
  one("5e-324");
  one("1.");
  one(".5");
  one("1e");
  one("nope");
  one("");

  /* ---- 十六进制 */
  one("0x1p3");
  one("0x1.8p1");
  one("-0xA.8p-2");
  one("0x10");
  one("0xp3");
  /* 次正规：缩放不能写成「先算 2 的幂再乘」（那个幂自己就是 0），
   * 第八刀第二十六片的 `ldexpReal` 分步做。 */
  one("0x0.88p-1022");
  one("0x88p-1030");
  one("0x1p-1074");
  one("0x1p-1075");
  one("0x1p4000");

  /* ---- inf / nan */
  one("inf");
  one("-INFINITY");
  one("nan");

  /* ---- 三条的差别：`strtof` 多舍一次到单精度 */
  char *e;
  printf("f=%.9g d=%.17g ld=%.17g\n",
    (double)strtof("0.1", &e), strtod("0.1", &e), (double)strtold("0.1", &e));
  printf("atof=%.17g\n", atof("2.5e-3"));

  sum = (int)strtod("42.9", &e);
  printf("sum=%d\n", sum);
  return sum & 0xff;
}
