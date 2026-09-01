/* 第六刀第二十二片：struct 进变参的可变部分（写侧摊进变参区、读侧 `va_arg` 回一个左值）。
 * arm64 上凡是用 printf 的用例都必须自己声明它，否则 tcc 自己会编错（变参 ABI）。 */
int printf(const char *fmt, ...);

struct pt { int x, y; };
struct big { int a; double d; char s[10]; };   /* 24 字节，跨三格 */

static int sumpt(int n, ...) {
  __builtin_va_list ap;
  int s = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) {
    struct pt p = __builtin_va_arg(ap, struct pt);   /* 赋值时才拷贝 */
    s += p.x * 10 + p.y;
  }
  __builtin_va_end(ap);
  return s;
}

/* `va_arg` 回的是左值，所以直接取成员也行（不必先拷一份） */
static int firstx(int n, ...) {
  __builtin_va_list ap;
  int x;
  __builtin_va_start(ap, n);
  x = __builtin_va_arg(ap, struct pt).x;
  __builtin_va_end(ap);
  return x;
}

static void mixed(int n, ...) {
  __builtin_va_list ap;
  __builtin_va_list ap2;
  __builtin_va_start(ap, n);
  __builtin_va_copy(ap2, ap);
  {
    int a = __builtin_va_arg(ap, int);
    struct pt p = __builtin_va_arg(ap, struct pt);
    double d = __builtin_va_arg(ap, double);
    struct big b = __builtin_va_arg(ap, struct big);
    const char *s = __builtin_va_arg(ap, const char *);
    printf("mixed %d %d %d %.1f %d %.1f %s %s\n", a, p.x, p.y, d, b.a, b.d, b.s, s);
  }
  {
    /* 第二遍：同一块变参区，走同一条分格规则 */
    int a2 = __builtin_va_arg(ap2, int);
    struct pt q = __builtin_va_arg(ap2, struct pt);
    printf("again %d %d %d\n", a2, q.x, q.y);
  }
  __builtin_va_end(ap2);
  __builtin_va_end(ap);
}

/* 变参函数里再调变参函数，struct 一路传下去 */
static int relay(int n, ...) {
  __builtin_va_list ap;
  struct pt p;
  __builtin_va_start(ap, n);
  p = __builtin_va_arg(ap, struct pt);
  __builtin_va_end(ap);
  return sumpt(2, p, p);
}

int main(void) {
  struct pt p1;
  struct pt p2;
  struct big b;
  p1.x = 1; p1.y = 2;
  p2.x = 3; p2.y = 4;
  b.a = 7; b.d = 2.5;
  b.s[0] = 'h'; b.s[1] = 'i'; b.s[2] = 0;

  printf("sum %d %d\n", sumpt(2, p1, p2), sumpt(1, p1));
  printf("firstx %d\n", firstx(1, p2));
  mixed(5, 9, p2, 1.5, b, "tail");
  printf("relay %d\n", relay(1, p2));
  return sumpt(1, p2) % 100;
}
