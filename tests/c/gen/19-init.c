/* 第六刀第十八片：嵌套聚合省掉里层花括号（C11 6.7.9 第 20 段）。
 * 一格一格地看：省的、写全的、混着写的；静态的与自动的；数组套 struct、struct 套数组。
 * arm64 上凡是用 printf 的用例都必须自己声明它，否则 tcc 自己会编错（变参 ABI）。 */
int printf(const char *fmt, ...);

struct in { int b, c; };
struct s { int a; struct in i; int d; };
union u { int n; char c[4]; };

/* 静态那一侧：字节直接铺进 data 段 */
static int sm[2][3] = { 1, 2, 3, 4, 5, 6 };
static struct s sg[2] = { 1, 2, 3, 4, { 5, { 6, 7 }, 8 } };
static char sn[3][4] = { "ab", "cd" };
static int sp[3][2] = { { 1 }, 5, 6 };
static struct in sq[2][2] = { 1, 2, 3, 4, 5, 6, 7, 8 };
/* 指定初始化器只作用在花括号那一层，省出来的层要先弹掉 */
static int sd[3][2] = { 1, 2, [2] = 7, 8 };
static union u su[2] = { 5, 6 };

int main(void) {
  /* 自动那一侧：一条一条 store */
  int a[2][2] = { 1, 2, 3, 4 };
  struct s l = { 9, 10, 11, 12 };
  struct s h = { 1, { 2, 3 }, 4 };
  int q[3][2] = { { 1 }, 5, 6 };
  char nm[2][4] = { "ab", "cd" };
  struct in g2[2][2] = { 1, 2, 3, 4, 5, 6 };
  int part[3][2] = { 1, 2, 3 };          /* 剩下的按 C 要零 */
  union u uu = { 65 };

  printf("a %d %d %d %d\n", a[0][0], a[0][1], a[1][0], a[1][1]);
  printf("l %d %d %d %d\n", l.a, l.i.b, l.i.c, l.d);
  printf("h %d %d %d %d\n", h.a, h.i.b, h.i.c, h.d);
  printf("q %d %d %d %d %d %d\n", q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1]);
  printf("nm %s %s\n", nm[0], nm[1]);
  printf("g2 %d %d %d %d %d %d %d %d\n",
         g2[0][0].b, g2[0][0].c, g2[0][1].b, g2[0][1].c,
         g2[1][0].b, g2[1][0].c, g2[1][1].b, g2[1][1].c);
  printf("part %d %d %d %d %d %d\n",
         part[0][0], part[0][1], part[1][0], part[1][1], part[2][0], part[2][1]);
  printf("uu %d %c\n", uu.n, uu.c[0]);

  printf("sm %d %d %d %d\n", sm[0][0], sm[0][2], sm[1][0], sm[1][2]);
  printf("sg %d %d %d %d %d %d\n",
         sg[0].a, sg[0].i.b, sg[0].i.c, sg[0].d, sg[1].i.b, sg[1].d);
  printf("sn %s %s %d\n", sn[0], sn[1], (int)sn[2][0]);
  printf("sp %d %d %d %d %d %d\n",
         sp[0][0], sp[0][1], sp[1][0], sp[1][1], sp[2][0], sp[2][1]);
  printf("sq %d %d %d %d\n", sq[0][0].b, sq[0][1].c, sq[1][0].b, sq[1][1].c);
  printf("sd %d %d %d %d %d %d\n",
         sd[0][0], sd[0][1], sd[1][0], sd[1][1], sd[2][0], sd[2][1]);
  printf("su %d %d\n", su[0].n, su[1].n);

  return sizeof(sq) / sizeof(sq[0][0]) + a[1][1] + sd[2][1];
}
