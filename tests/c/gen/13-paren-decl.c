/* 第六刀第十二片：带括号的声明符。
 *
 * 声明符里三段东西：前缀的 `*`、括号里的那一层、后缀的 `[]` 与 `(形参表)`。后缀绑得更紧，
 * 所以 `int *a[3]` 是「3 个 int*」而 `int (*a)[3]` 是「指向 int[3] 的指针」——
 * 括号是唯一能翻转这个次序的东西。
 *
 * 函数指针的**类型**在这一片就有了（能声明、能 sizeof、能当形参），
 * 但「调用它」要 MIR 有间接调用，那是下一片（`gen-bad/paren-decl` 钉着）。 */

int printf(const char *fmt, ...);

struct S {
  int (*p)[2];      /* 一个指针 */
  int *q[2];        /* 两个指针 */
};

/* 形参是「指向 int[3] 的指针」：`a[i][j]` 于是能按 3 一行地走 */
static int rowsum(int (*a)[3], int rows) {
  int s = 0;
  int i, j;
  for (i = 0; i < rows; i++) {
    for (j = 0; j < 3; j++) s += a[i][j];
  }
  return s;
}

/* 形参是函数指针：类型能收下（真调用还没到） */
static int takes_fp(int (*fp)(int), int n) {
  if (fp == 0) return n;
  return -1;
}

/* 回「指向 int[3] 的指针」的函数：`int (*f(int))[3]` —— 后缀连着两段 */
static int a2[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } };
static int (*pick(int i))[3] { return &a2[i]; }

int main(void) {
  int a[3];
  int (*p)[3] = &a;
  int *q[3];
  int x = 7;
  int (y) = 9;                 /* 括号套在名字上：什么都没变 */
  char *(*r)[2];
  char *strs[2] = { "ab", "cd" };
  int (**pp)[3] = &p;
  struct S s;
  int i;
  int t = 0;

  a[0] = 10;
  a[1] = 20;
  a[2] = 30;

  /* `(*p)[i]` 与 `p[0][i]` 是同一个东西 */
  t += (*p)[0] + p[0][1] + (*p)[2];              /* 60 */
  t += y;                                         /* 9 */

  q[0] = &x;
  q[1] = &a[1];
  q[2] = 0;
  t += *q[0] + *q[1];                             /* 7 + 20 */

  r = &strs;
  t += (*r)[0][0] + (*r)[1][1];                   /* 'a' + 'd' = 97 + 100 */

  t += (**pp)[0];                                 /* 10 */

  s.p = &a;
  s.q[0] = &x;
  s.q[1] = &a[2];
  t += (*s.p)[1] + *s.q[0] + *s.q[1];             /* 20 + 7 + 30 */

  t += rowsum(a2, 2);                             /* 21 */
  t += rowsum(pick(1), 1);                        /* 15 */
  t += takes_fp(0, 5);                            /* 5 */

  /* 抽象声明符：强制转换与 sizeof 里也是同一套 */
  t += (*(int (*)[3])&a)[2];                      /* 30 */
  printf("sizes %d %d %d %d %d\n",
    (int)sizeof(int (*)[3]),                      /* 一个指针 = 8 */
    (int)sizeof(int *[3]),                        /* 三个指针 = 24 */
    (int)sizeof(int (*)(int)),                    /* 函数指针 = 8 */
    (int)sizeof(*p),                              /* int[3] = 12 */
    (int)sizeof(struct S));                       /* 8 + 16 = 24 */

  /* 指针算术按元素走：`p + 1` 跳过整整一行 */
  {
    int (*rp)[3] = a2;
    t += (*rp)[0];                                /* 1 */
    rp++;
    t += (*rp)[0];                                /* 4 */
    t += (int)(rp - a2);                          /* 1 */
  }

  for (i = 0; i < 2; i++) t += (*pick(i))[i];      /* 1 + 5 */

  printf("t=%d\n", t);
  return t & 255;
}
