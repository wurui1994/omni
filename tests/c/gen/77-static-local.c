/* 第八刀第五十七片：块作用域的 `static`（与块里的 `extern`）。
 *
 * 函数里的 `static` 存储期是整个程序 —— 东西在 data 段上、初始化式是静态初始化式、
 * 只算一次。原先我们把它当普通局部量，于是每次调用都从头开始，而且静悄悄地错。 */
#include <stdio.h>

int gv = 7;
static int sv = 8;

static void counter(void) { static int n; n++; printf("n %d\n", n); }
static void withinit(void) { static int n = 10; n += 2; printf("i %d\n", n); }

/* 两个函数里各有一个同名的 static：是**两个**对象 */
static void tag1(void) { static struct { int x; } A; A.x++; printf("t1 %d\n", A.x); }
static void tag2(void) { static struct { int x; } A; printf("t2 %d\n", A.x); }

/* 同一个函数里两层块各有一个同名的 static：也是两个对象 */
static void twoblocks(int which) {
  if (which) { static int v = 100; v++; printf("b1 %d\n", v); }
  else { static int v = 200; v++; printf("b2 %d\n", v); }
}

/* 聚合与字符串的静态初始化式 */
static void aggr(void) {
  static char s[] = "ab";
  static int t[3] = { 1, 2 };
  static const char *p = "xy";
  s[0]++;
  t[2] += 5;
  printf("a %s %d %d %d %s\n", s, t[0], t[2], (int)sizeof s, p);
}

/* static 的地址是编译期常量，所以能用在另一个 static 的初始化式里 */
static void addr(void) {
  static int v = 3;
  static int *q = &v;
  *q += 1;
  printf("p %d %d\n", v, *q);
}

/* 块里的 extern 说的是文件作用域那一个 */
static void ext(void) {
  extern int gv;
  printf("e %d %d\n", gv, sv);
}

/* static 在循环里：只初始化一次 */
static void inloop(void) {
  for (int i = 0; i < 3; i++) { static int c = 5; c++; printf("l %d\n", c); }
}

int main(void) {
  counter(); counter(); counter();
  withinit(); withinit();
  tag1(); tag1(); tag2();
  twoblocks(1); twoblocks(0); twoblocks(1); twoblocks(0);
  aggr(); aggr();
  addr(); addr();
  ext();
  inloop();
  return 0;
}
