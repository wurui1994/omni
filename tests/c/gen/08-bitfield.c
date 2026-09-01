/* 第六刀第七片：位域。oracle 是 `tcc -run` 的退出码加 stdout 逐字节 ——
 * `sizeof` 与每个位域的读写结果都印出来，于是 PCC（gcc）那套布局规则被逐位钉住。
 *
 * 布局的三句话（`tccgen.c:4256-4294`）：位域紧挨着前一个放，除了宽度是 0 或者
 * 「放下去会越过它自己的基类型容器」这两种情形要换一个新的存储单元。 */

#include <stdio.h>

/* 三个位域挤在一个 int 里 */
struct A {
  unsigned int a : 3;
  unsigned int b : 5;
  unsigned int c : 1;
};

/* 有符号：`int:3` 存 7 读出来该是 -1 */
struct S {
  int a : 3;
  int b : 4;
  int c : 25;
};

/* 越过容器要换新单元：a 用了 30 位，b 要 5 位，30+5 > 32 */
struct Cross {
  unsigned int a : 30;
  unsigned int b : 5;
};

/* char 的容器只有 8 位 */
struct Ch {
  unsigned char a : 3;
  unsigned char b : 5;
  unsigned char c : 4;
};

/* 位域与普通成员混排：普通成员进来先把没排完的位冲成整字节 */
struct Mix {
  unsigned int a : 4;
  char c;
  unsigned int b : 4;
  int n;
};

/* 匿名位域只占位；宽度 0 的那个换一个存储单元 */
struct Pad {
  unsigned int a : 3;
  unsigned int : 5;
  unsigned int b : 4;
  unsigned int : 0;
  unsigned int d : 2;
};

/* PCC 模式下装得下的 long long 位域按 int 算 */
struct LL {
  long long a : 20;
  long long b : 40;
};

union UB {
  unsigned int a : 3;
  unsigned int b : 20;
  int n;
};

struct A ga;

int main(void) {
  int s = 0;

  printf("size A=%d S=%d Cross=%d Ch=%d Mix=%d Pad=%d LL=%d UB=%d\n",
         (int)sizeof(struct A), (int)sizeof(struct S), (int)sizeof(struct Cross),
         (int)sizeof(struct Ch), (int)sizeof(struct Mix), (int)sizeof(struct Pad),
         (int)sizeof(struct LL), (int)sizeof(union UB));

  struct A x;
  x.a = 5;
  x.b = 20;
  x.c = 1;
  printf("A: %u %u %u\n", x.a, x.b, x.c);
  s += x.a + x.b + x.c;                 /* 26 */

  /* 截断：3 位装不下 300，存进去的是 300 & 7 = 4 */
  x.a = 300;
  printf("trunc=%u\n", x.a);
  s += x.a;                             /* +4 -> 30 */
  /* 邻居没被踩到 */
  s += x.b + x.c;                       /* +21 -> 51 */

  /* 有符号的符号扩展 */
  struct S y;
  y.a = 7;
  y.b = -3;
  y.c = 1000;
  printf("S: %d %d %d\n", y.a, y.b, y.c);
  s += y.a + y.b + y.c;                 /* -1 + -3 + 1000 = 996 -> 1047 */

  struct Cross cr;
  cr.a = 1000000;
  cr.b = 17;
  printf("Cross: %u %u\n", cr.a, cr.b);
  s += cr.b;                            /* +17 -> 1064 */

  struct Ch ch;
  ch.a = 7;
  ch.b = 31;
  ch.c = 9;
  printf("Ch: %u %u %u\n", ch.a, ch.b, ch.c);
  s += ch.a + ch.b + ch.c;              /* 47 -> 1111 */

  struct Mix mx;
  mx.a = 9;
  mx.c = 'A';
  mx.b = 3;
  mx.n = 77;
  printf("Mix: %u %d %u %d\n", mx.a, mx.c, mx.b, mx.n);
  s += mx.a + mx.c + mx.b + mx.n;       /* 9+65+3+77 = 154 -> 1265 */

  struct Pad pd;
  pd.a = 6;
  pd.b = 11;
  pd.d = 2;
  printf("Pad: %u %u %u\n", pd.a, pd.b, pd.d);
  s += pd.a + pd.b + pd.d;              /* 19 -> 1284 */

  struct LL ll;
  ll.a = 123456;
  ll.b = 1099511627775LL;               /* 2^40 - 1，40 位全 1，有符号读回是 -1 */
  printf("LL: %d %d\n", (int)ll.a, (int)ll.b);
  s += (int)ll.a + (int)ll.b;           /* 123456 - 1 = 123455 -> 124739 */

  /* union 里位域都从第 0 位起 */
  union UB u;
  u.n = 0;
  u.b = 0xABCDE;
  printf("UB: %u %u %d\n", u.a, u.b, u.n);
  s += u.a;                             /* 0xABCDE & 7 = 6 -> 124745 */

  /* 复合赋值与自增走的是「读、算、写」那条路 */
  x.b = 1;
  x.b += 5;
  x.b++;
  printf("compound=%u\n", x.b);
  s += x.b;                             /* +7 -> 124752 */

  /* 位域上的比较 */
  if (y.a == -1) s += 3;                /* -> 124755 */
  if (x.c) s += 4;                      /* -> 124759 */

  /* 全局的位域 struct：出生是 0 */
  s += ga.a + ga.b + ga.c;              /* +0 */
  ga.b = 17;
  s += ga.b;                            /* +17 -> 124776 */

  printf("s=%d\n", s);
  return s & 255;
}
