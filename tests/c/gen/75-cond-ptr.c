/* 第八刀第五十五片：`? :` 两支里有指针时的结果类型（C11 6.5.15 第 6 段）。
 *
 * 三条：一支是空指针常量就取另一支；指针与整数取那个指针；两支都是指针时
 * 「指向 void 的优先」，限定符并起来，长度未定的数组让位给写了长度的。 */
#include <stdio.h>

struct S { int i; int j; };

/* 空指针常量在哪一支都行（tcctest.c:4100 那四行。那儿的 `getme` 从来没被调用过 ——
 * 它考的是能不能编。这里让选中的那一支永远是 s，于是既编得过也跑得出数）。 */
static int getme(struct S *s, int i) {
  int i1 = (i == 0 ? 0 : s)->i;
  int i2 = (i != 0 ? s : 0)->i;
  int i3 = (i == 0 ? (void *)0 : s)->i;
  int i4 = (i != 0 ? s : (void *)0)->i;
  return i1 + i2 + i3 + i4;
}

int main(void) {
  struct S st = { 7, 9 };
  printf("g %d\n", getme(&st, 1));

  /* 空指针常量的各种写法：0 / 0L / (void*)0，两边都试（真正取的那一支都是 p） */
  struct S *p = &st;
  printf("n %d %d %d %d\n", (1 ? p : 0)->j, (0 ? 0 : p)->j,
         (1 ? p : 0L)->j, (0 ? (void *)0 : p)->j);

  /* 指向 void 的优先：结果是 void *，所以要转回去才能用 */
  void *v = &st;
  printf("v %d %d\n", ((struct S *)(1 ? v : p))->i, ((struct S *)(1 ? p : v))->i);

  /* 限定符并起来：`const char *` 与 `char *` -> `const char *` */
  char buf[8] = "abc";
  const char *cp = "xyz";
  char *mp = buf;
  printf("q %c %c\n", *(1 ? cp : mp), *(0 ? cp : mp));

  /* 元素类型上的算术还是按那个指针类型走（步长对不对） */
  int arr[4] = { 10, 20, 30, 40 };
  int *ip = arr;
  printf("s %d %d\n", *((1 ? ip : 0) + 2), (int)sizeof(*(1 ? ip : (void *)0)));

  /* 指向长度未定的数组让位给写了长度的那一个 */
  int m[3][5];
  int (*a5)[5] = m;
  int (*a0)[] = m;
  printf("a %d %d\n", (int)sizeof(*(1 ? a0 : a5)), (int)sizeof(*(1 ? a5 : a0)));

  /* 两支都是同一个指针类型：什么都不变 */
  int *q = arr + 1;
  printf("p %d %d\n", *(1 ? ip : q), *(0 ? ip : q));
  return 0;
}
