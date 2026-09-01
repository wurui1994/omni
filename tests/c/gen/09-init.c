/* 第六刀第八片：聚合初始化器。静态（data 段）与自动（栈上）走同一段代码，
 * 所以这一份用例把每一种写法都在**全局与局部各来一遍** —— 两条路要给同一个答案。
 *
 * oracle 是 `tcc -run` 的退出码加 stdout 逐字节。 */

int printf(const char *fmt, ...);

struct P { int x; int y; };
struct N { struct P a; char c; int v[3]; };
union U { int i; char b[4]; };

/* ---- 静态这一侧 */
int ga[4] = { 1, 2, 3, 4 };
int gpart[5] = { 7, 8 };              /* 剩下三个是 0 */
int gauto[] = { 10, 20, 30 };         /* 长度由初始化式定 */
char gs[] = "hello";                  /* 6 个字节，含结尾的 0 */
char gs2[8] = "hi";                   /* 后面 5 个字节是 0 */
char gtight[3] = "abc";               /* 装不下的那个结尾 0 丢掉（C11 6.7.9 第 14 段）*/
struct P gp = { 3, 4 };
struct P gp1 = { 5 };                 /* y 是 0 */
struct N gn = { { 1, 2 }, 'z', { 9, 8, 7 } };
struct P garr[2] = { { 1, 2 }, { 3, 4 } };
int gdes[6] = { [4] = 40, [1] = 10 }; /* 指定初始化器 */
struct P gdot = { .y = 9, .x = 2 };
union U gu = { 0x41424344 };
char *gptrs[3] = { "aa", "bbb", 0 };

int main(void) {
  int s = 0;
  int i;

  printf("sizes: gauto=%d gs=%d gtight=%d\n",
         (int)sizeof(gauto), (int)sizeof(gs), (int)sizeof(gtight));

  /* ---- 静态那一侧读回来 */
  for (i = 0; i < 4; i++) s += ga[i];                 /* 10 */
  for (i = 0; i < 5; i++) s += gpart[i];              /* +15 -> 25 */
  for (i = 0; i < 3; i++) s += gauto[i];              /* +60 -> 85 */
  printf("gs=%s gs2=%s\n", gs, gs2);
  s += gs[0] + gs[5];                                 /* 'h' + 0 = 104 -> 189 */
  s += gtight[0] + gtight[2];                         /* 'a'+'c' = 196 -> 385 */
  s += gp.x * gp.y + gp1.x + gp1.y;                   /* 12+5+0 = 17 -> 402 */
  s += gn.a.x + gn.a.y + gn.c + gn.v[0] + gn.v[2];    /* 1+2+122+9+7 = 141 -> 543 */
  s += garr[0].x + garr[1].y;                         /* 1+4 -> 548 */
  for (i = 0; i < 6; i++) s += gdes[i];               /* 50 -> 598 */
  s += gdot.x * 10 + gdot.y;                          /* 29 -> 627 */
  printf("gu.b=%d %d %d %d\n", gu.b[0], gu.b[1], gu.b[2], gu.b[3]);
  s += gu.b[0] + gu.b[3];                             /* 0x44 + 0x41 = 133 -> 760 */
  printf("gptrs=%s/%s\n", gptrs[0], gptrs[1]);
  s += (int)gptrs[1][2];                              /* 'b' = 98 -> 858 */

  /* ---- 自动这一侧：一模一样的写法 */
  int la[4] = { 1, 2, 3, 4 };
  int lpart[5] = { 7, 8 };
  int lauto[] = { 10, 20, 30 };
  char ls[] = "hello";
  char ls2[8] = "hi";
  char ltight[3] = "abc";
  struct P lp = { 3, 4 };
  struct P lp1 = { 5 };
  struct N ln = { { 1, 2 }, 'z', { 9, 8, 7 } };
  struct P larr[2] = { { 1, 2 }, { 3, 4 } };
  int ldes[6] = { [4] = 40, [1] = 10 };
  struct P ldot = { .y = 9, .x = 2 };
  union U lu = { 0x41424344 };
  char *lptrs[3] = { "aa", "bbb", 0 };

  printf("sizes: lauto=%d ls=%d ltight=%d\n",
         (int)sizeof(lauto), (int)sizeof(ls), (int)sizeof(ltight));

  for (i = 0; i < 4; i++) s += la[i];
  for (i = 0; i < 5; i++) s += lpart[i];
  for (i = 0; i < 3; i++) s += lauto[i];
  printf("ls=%s ls2=%s\n", ls, ls2);
  s += ls[0] + ls[5];
  s += ltight[0] + ltight[2];
  s += lp.x * lp.y + lp1.x + lp1.y;
  s += ln.a.x + ln.a.y + ln.c + ln.v[0] + ln.v[2];
  s += larr[0].x + larr[1].y;
  for (i = 0; i < 6; i++) s += ldes[i];
  s += ldot.x * 10 + ldot.y;
  printf("lu.b=%d %d %d %d\n", lu.b[0], lu.b[1], lu.b[2], lu.b[3]);
  s += lu.b[0] + lu.b[3];
  printf("lptrs=%s/%s\n", lptrs[0], lptrs[1]);
  s += (int)lptrs[1][2];

  /* 局部量的初始化式**不必是常量**（静态那一侧必须是）—— 这是两条路真正的差别 */
  int n = 3;
  int dyn[3] = { n, n * 2, n + 100 };
  s += dyn[0] + dyn[1] + dyn[2];        /* 3+6+103 = 112 */

  /* 标量外面套一层花括号是合法的 */
  int one = { 42 };
  s += one;

  /* 二维数组：里层的花括号写全 */
  int m[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } };
  s += m[0][0] + m[1][2] + m[1][0];     /* 1+6+4 = 11 */

  /* struct 之间的整块赋值仍然走 structCopy，不是聚合初始化器 */
  struct P cp = lp;
  s += cp.x + cp.y;                     /* 7 */

  printf("s=%d\n", s);
  return s & 255;
}
