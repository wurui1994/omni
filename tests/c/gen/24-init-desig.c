int printf(const char *fmt, ...);

struct in { int b, c; };
struct s { int a; struct in i; int d; };

/* 串起来的指定初始化器 */
static struct s g1 = { .i.b = 3, 4, .a = 1 };
static int g2[2][3] = { [1][2] = 9, [0][0] = 1 };
static struct s g3[2] = { [1].i.c = 5 };

/* 不定长数组配省掉里层花括号 */
static int f1[][2] = { 1, 2, 3, 4 };
static int f2[][2] = { 1, 2, 3 };
static int f3[][2] = { { 1 }, 2, 3, 4 };
static struct s f4[] = { 1, 2, 3, 4 };
static char f5[][4] = { "ab", "cd", "ef" };
static int f6[] = { 1, 2, 3 };

int main(void) {
  int a[][3] = { 1, 2, 3, 4 };
  struct s l = { .i.c = 7, .a = 2 };
  printf("g1 %d %d %d %d\n", g1.a, g1.i.b, g1.i.c, g1.d);
  printf("g2 %d %d %d\n", g2[0][0], g2[1][2], g2[0][1]);
  printf("g3 %d %d\n", g3[1].i.c, g3[0].a);
  printf("sz %d %d %d %d %d %d\n",
         (int)(sizeof f1 / sizeof f1[0]), (int)(sizeof f2 / sizeof f2[0]),
         (int)(sizeof f3 / sizeof f3[0]), (int)(sizeof f4 / sizeof f4[0]),
         (int)(sizeof f5 / sizeof f5[0]), (int)(sizeof f6 / sizeof f6[0]));
  printf("f1 %d %d %d %d\n", f1[0][0], f1[0][1], f1[1][0], f1[1][1]);
  printf("f2 %d %d %d %d\n", f2[0][0], f2[0][1], f2[1][0], f2[1][1]);
  printf("f3 %d %d %d %d\n", f3[0][0], f3[0][1], f3[1][0], f3[1][1]);
  printf("f4 %d %d %d %d\n", f4[0].a, f4[0].i.b, f4[0].i.c, f4[0].d);
  printf("f5 %s %s %s\n", f5[0], f5[1], f5[2]);
  printf("loc %d %d %d %d %d\n", (int)(sizeof a / sizeof a[0]), a[0][2], a[1][0], l.a, l.i.c);
  return g1.i.b + f2[1][0] + l.i.c;
}
