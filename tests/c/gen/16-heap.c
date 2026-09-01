/* 第六刀第十五片：堆（`malloc` / `calloc` / `realloc` / `free` / `strdup`）。
 *
 * 分配器在 `stage0/src/interp/libc.js` 里，**簿记全在线性内存上**（16 字节块头 +
 * 隐式空闲链表 + 首次适配 + free 之后合并），宿主那边一个字节的状态都不留。
 * 版图上堆从影子栈之上的下一个页边界起，不够就 `MGROW`；起点由入口函数在 `main`
 * 之前用一条 `__omni_heap_init` 交过去 —— 用到堆才发那条。
 *
 * 这一份**不印任何地址**（`%p` 与 tcc 对不上，地址空间不同），只印内容与长度。
 *
 * printf 一定要有声明：arm64 的变参走栈，没声明时 **tcc 自己**会编错 ——
 * 第八刀第三片起那个声明从 `<stdio.h>` 来，不必手写。 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Node { int v; struct Node *next; };

/* 一条链表：malloc 出来的东西彼此不重叠，这是分配器的第一条不变量 */
static struct Node *push(struct Node *head, int v) {
  struct Node *n = (struct Node *)malloc(sizeof(struct Node));
  n->v = v;
  n->next = head;
  return n;
}

int main(void) {
  int i;

  /* 一、malloc + 写 + 读 */
  int *a = (int *)malloc(4 * sizeof(int));
  for (i = 0; i < 4; i++) a[i] = i * i;
  printf("%d %d %d %d\n", a[0], a[1], a[2], a[3]);

  /* 二、calloc 是零初始化的（C11 7.22.3.2） */
  int *z = (int *)calloc(6, sizeof(int));
  printf("%d%d%d%d%d%d\n", z[0], z[1], z[2], z[3], z[4], z[5]);

  /* 三、realloc 长大：原来的内容要留着 */
  a = (int *)realloc(a, 8 * sizeof(int));
  for (i = 4; i < 8; i++) a[i] = i * 10;
  printf("%d %d %d %d\n", a[0], a[3], a[4], a[7]);

  /* 四、realloc 变小回同一块；`realloc(0, n)` 就是 malloc */
  int *sm = (int *)realloc(a, 2 * sizeof(int));
  printf("%d %d\n", sm[0], sm[1]);
  int *fresh = (int *)realloc(0, sizeof(int));
  *fresh = 42;
  printf("%d\n", *fresh);

  /* 五、strdup */
  char *s = strdup("hello, heap");
  printf("%s %d %d\n", s, (int)strlen(s), strcmp(s, "hello, heap"));

  /* 六、链表：五块互不重叠 */
  struct Node *head = 0;
  for (i = 1; i <= 5; i++) head = push(head, i);
  int sum = 0;
  struct Node *p = head;
  while (p) { sum += p->v; p = p->next; }
  printf("%d\n", sum);

  /* 七、free 之后再 malloc：那几块要能复用（合并之后一块 100 字节的够装下） */
  while (head) { struct Node *nx = head->next; free(head); head = nx; }
  char *reuse = (char *)malloc(100);
  strcpy(reuse, "reused");
  printf("%s\n", reuse);

  /* 八、`free(NULL)` 什么都不做；`malloc(0)` 也给一块真地址 */
  free(0);
  char *zero = (char *)malloc(0);
  printf("%d\n", zero != 0);

  /* 九、大到要长内存（初始只有一页堆） */
  char *big = (char *)malloc(200000);
  big[0] = 'A';
  big[100000] = 'M';
  big[199999] = 'Z';
  printf("%c%c%c\n", big[0], big[100000], big[199999]);

  /* 十、交替分配与释放，一路走下来内容不该串 */
  char *k[8];
  for (i = 0; i < 8; i++) {
    k[i] = (char *)malloc(24);
    k[i][0] = (char)('a' + i);
    k[i][1] = 0;
  }
  for (i = 0; i < 8; i += 2) free(k[i]);
  for (i = 1; i < 8; i += 2) printf("%s", k[i]);
  printf("\n");

  free(sm);
  free(fresh);
  free(s);
  free(reuse);
  free(zero);
  free(big);
  for (i = 1; i < 8; i += 2) free(k[i]);

  return (sum + (int)strlen("heap")) & 255;
}
