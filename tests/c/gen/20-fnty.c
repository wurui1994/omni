/* 第六刀第十九片：函数类型的 typedef，与通过函数指针调变参函数。
 * arm64 上凡是用 printf 的用例都必须自己声明它，否则 tcc 自己会编错（变参 ABI）。 */
int printf(const char *fmt, ...);
int sprintf(char *buf, const char *fmt, ...);

typedef int cb(int);                 /* 函数类型本身的别名 */
typedef int pf(const char *, ...);   /* 变参函数类型的别名 */
typedef cb *cbp;                     /* 再套一层：指向它的指针 */

static int twice(int x) { return x * 2; }
static int thrice(int x) { return x * 3; }

/* 拿 typedef 当声明符的基本类型：声明一个函数、当形参（要退化成指针）、当返回值 */
cb plus1;
int plus1(int x) { return x + 1; }

static int apply(cb *f, int x) { return f(x); }
static int applyByVal(cb f, int x) { return f(x); }   /* 形参是函数类型 -> 指针 */
static cb *pick(int n) { return n == 0 ? twice : thrice; }

/* 自家的变参函数，也从指针上调 */
static int total(int n, ...) {
  __builtin_va_list ap;
  int s = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, int);
  __builtin_va_end(ap);
  return s;
}

int main(void) {
  cb *p = twice;
  cbp q = plus1;
  cb *tab[3];
  pf *fp = printf;                     /* 变参函数指针，从 typedef 上来 */
  int (*sp)(char *, const char *, ...) = sprintf;
  int (*tp)(int, ...) = total;
  char buf[32];

  tab[0] = twice;
  tab[1] = thrice;
  tab[2] = plus1;

  printf("a %d %d %d\n", p(5), q(5), apply(thrice, 5));
  printf("b %d %d %d\n", applyByVal(plus1, 5), pick(0)(5), pick(1)(5));
  printf("c %d %d %d\n", tab[0](1), tab[1](1), tab[2](1));
  fp("d %d %s\n", 7, "via pointer");
  sp(buf, "%d-%s-%d", 1, "mid", 2);
  printf("e %s\n", buf);
  printf("f %d %d\n", tp(3, 10, 20, 30), tp(0));
  return p(3) + tp(2, 1, 2);
}
