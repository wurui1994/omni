/* 第六刀第六片：struct / union / enum 与成员访问。
 * oracle 是 `tcc -run` 的退出码加 stdout 逐字节 —— sizeof 与成员偏移都印出来，
 * 于是 struct 布局（对齐、填充、整体大小）被逐位钉住，而不只是「能编过」。
 *
 * printf 的声明必须先有（arm64 的变参实参走栈，没有声明时 **tcc 自己**就印出乱码 ——
 * 那会让 oracle 变成一份垃圾）；第八刀第三片起它从 `<stdio.h>` 来。 */

#include <stdio.h>

struct Point {
  int x;
  int y;
};

/* 对齐与填充：char 后面要补 3 个字节，long long 要 8 对齐。 */
struct Mixed {
  char c;
  int i;
  char d;
  long long q;
  short s;
};

struct Nested {
  struct Point a;
  struct Point b;
  char tag;
};

union Bits {
  long long q;
  int i;
  char b[8];
};

enum Color { RED, GREEN, BLUE };
enum Odd { LOW = 10, MID, HIGH = LOW * 3, TOP };

typedef struct Point Pt;

/* 不完整类型的指针：`struct Later` 这时还没有成员表。 */
struct Later;
struct Holder {
  struct Later *next;
  int n;
};
struct Later {
  int deep;
};

/* 全局的 struct：零初始化不花一个字节 data。 */
struct Mixed gm;
struct Point gp;

static int sum(struct Point *p) {
  return p->x + p->y;
}

static void bump(struct Point *p, int d) {
  p->x += d;
  p->y += d;
}

int main(void) {
  int s = 0;

  printf("sizeof Point=%d Mixed=%d Nested=%d Bits=%d\n",
         (int)sizeof(struct Point), (int)sizeof(struct Mixed),
         (int)sizeof(struct Nested), (int)sizeof(union Bits));

  struct Point p;
  p.x = 3;
  p.y = 4;
  s += p.x * p.y;                    /* 12 */

  /* 指针与箭头 */
  struct Point *q = &p;
  q->x = 10;
  s += sum(q);                       /* +14 -> 26 */
  bump(q, 1);
  printf("p=(%d,%d)\n", p.x, p.y);
  s += p.x + p.y;                    /* +16 -> 42 */

  /* `(*q).f` 与 `q->f` 是同一件事 */
  s += (*q).x;                       /* +11 -> 53 */

  /* 整块赋值 */
  struct Point r;
  r = p;
  r.x = 100;
  printf("r=(%d,%d) p=(%d,%d)\n", r.x, r.y, p.x, p.y);
  s += r.y;                          /* +5 -> 58 */

  /* 嵌套：静态偏移一路加下去，`n.a.x` 是一条 mload */
  struct Nested n;
  n.a.x = 1;
  n.a.y = 2;
  n.b = p;
  n.tag = 'z';
  s += n.a.x + n.a.y + n.b.x + n.b.y + n.tag;   /* 1+2+11+5+122 = 141 -> 199 */

  /* struct 的数组 */
  struct Point arr[3];
  int i = 0;
  while (i < 3) {
    arr[i].x = i;
    arr[i].y = i * i;
    i++;
  }
  s += arr[2].x + arr[2].y;          /* +6 -> 205 */
  s += sum(&arr[1]);                 /* +2 -> 207 */

  /* union：同一块字节两种读法 */
  union Bits u;
  u.q = 0;
  u.b[0] = 1;
  u.b[1] = 2;
  printf("u.i=%d\n", u.i);
  s += u.i;                          /* +513 -> 720 */

  /* 填充：成员偏移用两个成员的地址之差量出来，和 tcc 逐位对 */
  struct Mixed m;
  printf("off i=%d d=%d q=%d s=%d\n",
         (int)((char *)&m.i - (char *)&m),
         (int)((char *)&m.d - (char *)&m),
         (int)((char *)&m.q - (char *)&m),
         (int)((char *)&m.s - (char *)&m));

  /* enum：连号、显式赋值、接着连号 */
  printf("colors=%d %d %d odd=%d %d %d %d\n",
         RED, GREEN, BLUE, LOW, MID, HIGH, TOP);
  s += BLUE + TOP;                   /* 2 + 31 = 33 -> 753 */
  enum Color c = GREEN;
  if (c == GREEN) s += 7;            /* -> 760 */
  int arr2[BLUE + 2];                /* enum 常量当数组维度 */
  s += (int)sizeof(arr2);            /* +16 -> 776 */

  /* typedef 的 struct */
  Pt t;
  t.x = 2;
  t.y = 3;
  s += sum(&t);                      /* +5 -> 781 */

  /* 不完整类型的指针，后来补全 */
  struct Later later;
  struct Holder h;
  later.deep = 9;
  h.next = &later;
  h.n = 4;
  s += h.next->deep * h.n;           /* +36 -> 817 */

  /* 全局的 struct：出生就是 0 */
  s += gm.i + gp.x + gp.y;           /* +0 */
  gm.q = 6;
  gp = p;
  s += (int)gm.q + gp.x;             /* +17 -> 834 */

  printf("s=%d\n", s);
  return s & 255;
}
