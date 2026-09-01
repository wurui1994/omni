/* 第六刀第二十一片：常量表达式里的浮点（整型与浮点两个求值器合成一份）与 printf 的 `%a`。
 * arm64 上凡是用 printf 的用例都必须自己声明它，否则 tcc 自己会编错（变参 ABI）。 */
int printf(const char *fmt, ...);

/* 整型的位置上出现浮点常量：向零截断（C11 6.3.1.4 第 1 段） */
static int a = 1.9;
static int an = -1.9;
static char c = 65.7;
static unsigned char uc = 300.9;      /* 截断之后还要按宽度回绕 */
static int mix = (1.5 + 1) * 2;       /* 括号里不提前截断，5 而不是 4 */
static int half = 1 / 2;              /* 两边都是整数就在整数里算 */
static double dhalf = 1 / 2;          /* 同上，所以是 0.0 */
static double dh2 = 1.0 / 2;
static int cmp = 1.5 < 2;             /* 浮点的比较，结果是 int */
static int lnot = !0.0;
static int land = 1.5 && 0.0;
static long lg = -2.7;
static int cast = (int)2.9;
static int b1 = (_Bool)2.5;
static int tab[(int)3.7];             /* 数组维度上的浮点常量 */
static double fromint = 3;

enum { E1 = (int)1.9, E2 = E1 + 1 };

int main(void) {
  int k = 3.99;                       /* 自动量的初始化式走的是运行期那条路 */
  switch (k) {
    case (int)1.5: return 90;
    case 3: break;
    default: return 91;
  }
  printf("int %d %d %d %d %d\n", a, an, (int)c, (int)uc, mix);
  printf("div %d %.1f %.1f\n", half, dhalf, dh2);
  printf("bool %d %d %d %d\n", cmp, lnot, land, b1);
  printf("misc %ld %d %d %d %d\n", lg, cast, (int)(sizeof tab / sizeof tab[0]), E1, E2);
  printf("run %d %.1f\n", k, fromint);

  /* `%a`：把 double 的位模式印成十六进制浮点 */
  printf("a %a %a %a\n", 1.5, 0.0, -3.25);
  printf("a %a %a\n", 1.0 / 3, 65536.0);
  printf("A %A %.2a %.0a %#.0a\n", 1.5, 1.0 / 3, 1.5, 1.5);
  printf("rnd %.0a %.0a %.1a %.20a\n", 1.75, 2.5, 1.999999, 1.5);
  printf("sub %a %a\n", 5e-324, 1e-310);
  printf("pad [%12.3a][%-12.3a][%012.3a]\n", 1.0 / 3, 1.0 / 3, 1.0 / 3);
  return a + mix + E2;
}
