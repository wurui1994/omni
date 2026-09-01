/* 第八刀第二十六片：tag 是**分作用域**的（C11 6.2.1 第 7 段）。
 *
 * 这一格是编 tinycc 自己那份 `tests/tcctest.c` 撞出来的：函数体在我们这儿要走两遍
 * （第一遍数帧、第二遍发指令），tag 表原先只有一张，于是块里的 `struct S {…}`
 * 第二遍再看见就成了「redefinition」。顺带外层同名的 tag 该被遮蔽，那也是这张表的事。 */
#include <stdio.h>

struct S { int a; int b; };          /* 文件作用域的 S */
enum E { E_OUT = 7 };

static struct S g = { 1, 2 };

/* 块里定义一个同名的 struct：与外层那个是**两个类型** */
static int inner(void) {
  struct S { char c[3]; long v; };
  struct S s;
  s.c[0] = 'x';
  s.v = 42;
  printf("inner: sizeof=%d c0=%c v=%ld\n", (int)sizeof(struct S), s.c[0], s.v);
  return (int)sizeof(struct S) + (int)s.v;
}

/* 静态的、带 tag 的、还被取过地址的 —— 两遍都要认得它 */
static int addr_taken(void) {
  static struct T { int x; int y; } t = { 3, 4 };
  struct T *p = &t;
  p->x += p->y;
  printf("addr_taken: %d %d\n", t.x, t.y);
  return t.x;
}

/* 块里的 enum 与 union，外层也有同名的 */
static int enums(void) {
  enum E { E_IN = 5, E_IN2 };
  union U { int i; char b[4]; } u;
  u.i = 0;
  u.b[0] = 9;
  printf("enums: E_IN=%d E_IN2=%d u=%d\n", E_IN, E_IN2, u.i);
  return E_IN + E_IN2 + u.i;
}

/* 嵌套的块里再来一层同名 tag */
static int nested(void) {
  struct N { int k; } n1;
  n1.k = 1;
  {
    struct N { double d; } n2;
    n2.d = 2.5;
    printf("nested inner: sizeof=%d d=%.1f\n", (int)sizeof(struct N), n2.d);
  }
  printf("nested outer: sizeof=%d k=%d\n", (int)sizeof(struct N), n1.k);
  return n1.k;
}

int main(void) {
  int sum = 0;
  printf("outer: sizeof(struct S)=%d g=%d %d E_OUT=%d\n",
         (int)sizeof(struct S), g.a, g.b, E_OUT);
  sum += inner();
  sum += addr_taken();
  sum += enums();
  sum += nested();
  printf("sum=%d\n", sum);
  return sum & 0xff;
}
