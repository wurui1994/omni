/* 第六刀第十一片：struct 的传值与返回。
 *
 * 我们的 ABI（前端这一层）：传值传**地址**，拷贝由被调方在入口处做（C 要求形参是实参的
 * 一份可改的拷贝）；返回走**隐藏的第一个形参** —— 调用方划一块、把地址传进去，被调方
 * 拷进去再把这个地址返回（SysV 用 rax 回同一个东西）。
 *
 * printf 一定要有原型：arm64 的变参走栈，没原型时 **tcc 自己**会编错。 */

int printf(const char *fmt, ...);

struct Point { int x, y; };                  /* 8 字节，真 ABI 里能走寄存器 */
struct Big { int a[6]; char tag; };          /* 28 字节，一定走内存 */
struct Wrap { struct Point p; int n; };
union U { int i; char c[4]; };
struct Bits { unsigned a : 3; unsigned b : 5; int n; };

/* 收一个、改它、回一个新的 —— 改的必须是**自己那份拷贝** */
static struct Point bump(struct Point p) {
  p.x += 1;
  p.y += 2;
  return p;
}

static int psum(struct Point p) { return p.x * 10 + p.y; }

static struct Point mk(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}

/* 两个 struct 实参 */
static struct Point add(struct Point a, struct Point b) {
  return mk(a.x + b.x, a.y + b.y);
}

/* 大 struct：拷贝要拷全 28 字节 */
static int bigsum(struct Big b) {
  int s = 0;
  int i;
  for (i = 0; i < 6; i++) s += b.a[i];
  b.a[0] = 999;                 /* 改自己那份，调用方看不见 */
  return s + b.tag;
}

static struct Big mkbig(int base) {
  struct Big b;
  int i;
  for (i = 0; i < 6; i++) b.a[i] = base + i;
  b.tag = 7;
  return b;
}

/* 形参被取地址：它已经在帧上，`&p` 直接可用 */
static int viaptr(struct Point p) {
  struct Point *q = &p;
  q->x += 100;
  return p.x + p.y;
}

/* 嵌套的 struct 与 union、位域 —— 逐字节拷贝要一视同仁 */
static int wrapsum(struct Wrap w) { return w.p.x + w.p.y * 2 + w.n * 3; }
static struct Wrap mkwrap(int x, int y, int n) {
  struct Wrap w;
  w.p = mk(x, y);
  w.n = n;
  return w;
}
static int usum(union U u) { return u.c[0] + u.c[1] * 2; }
static int bsum(struct Bits b) { return b.a + b.b * 8 + b.n; }
static struct Bits mkbits(unsigned a, unsigned b, int n) {
  struct Bits r;
  r.a = a;
  r.b = b;
  r.n = n;
  return r;
}

/* 递归 + 返回 struct：每一层都有自己那块返回地方 */
static struct Point walk(int n) {
  if (n == 0) return mk(0, 0);
  return add(walk(n - 1), mk(1, n));
}

/* 全局的 struct 当实参：地址是编译期常量 */
static struct Point g = { 3, 4 };

int main(void) {
  struct Point p = { 1, 2 };
  struct Point q;
  struct Big b;
  struct Wrap w;
  union U u;
  int s = 0;

  q = bump(p);
  printf("p=%d,%d q=%d,%d\n", p.x, p.y, q.x, q.y);   /* p 一点没变 */
  s += psum(p) + psum(q);                             /* 12 + 24 */

  /* 返回值直接用：`f().x` 与 `f(f(x))` 都要能行 */
  s += mk(5, 6).y;                                    /* 6 */
  s += psum(bump(bump(p)));                           /* (3,6) -> 36 */
  s += add(p, q).x + add(p, q).y;                      /* 3 + 6 */

  b = mkbig(10);
  s += bigsum(b);                                     /* 10+..+15 + 7 = 82 */
  printf("b.a0=%d b.tag=%d\n", b.a[0], b.tag);        /* 被调方改的是它自己那份 */

  s += viaptr(p);                                     /* 101 + 2 */
  s += viaptr(g);                                     /* 103 + 4 */

  w = mkwrap(1, 2, 3);
  s += wrapsum(w) + wrapsum(mkwrap(4, 5, 6));         /* 14 + 32 */

  u.i = 0;
  u.c[0] = 5;
  u.c[1] = 6;
  s += usum(u);                                       /* 17 */

  s += bsum(mkbits(5, 20, 7));                        /* 5 + 160 + 7 */

  q = walk(4);
  printf("walk=%d,%d\n", q.x, q.y);                   /* (4, 1+2+3+4) */
  s += q.x + q.y;

  /* struct 实参可以是成员、可以是解引用 */
  s += psum(w.p) + psum(*&p);                          /* 12 + 12 */

  printf("s=%d\n", s);
  return s & 255;
}
