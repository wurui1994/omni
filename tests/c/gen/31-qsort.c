/* 第八刀第五片：`qsort` / `bsearch` —— libc 回头调 MIR。
 *
 * 这一片与前几片不是同一类活：比较器是 C 里的一个**函数指针**，而在这之前 CCALL 是
 * 一扇单向门（MIR 调宿主）。门开在 `interp/libc.js` 的 `setFnPtrCaller` 上，
 * 由跑模块的那一层装上 —— 函数指针值的编码（函数号 + 1）是 MIR 的事。
 *
 * 用例里**没有比较相等的元素**：C 不要求 qsort 稳定，相等元素之间的次序未规定
 * （C11 7.22.5.2），而宿主的 libc 与我们的插入排序不是同一个算法。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int cmpInt(const void *a, const void *b) {
  int x = *(const int *)a;
  int y = *(const int *)b;
  return x < y ? -1 : (x > y ? 1 : 0);
}

/* 倒过来排：比较器的方向就是次序的方向，没有别的开关 */
static int cmpDown(const void *a, const void *b) {
  return cmpInt(b, a);
}

struct rec { int key; char tag; };

static int cmpRec(const void *a, const void *b) {
  return ((const struct rec *)a)->key - ((const struct rec *)b)->key;
}

/* 比较器自己也能有副作用（它是真的在跑我们这边的代码） */
static int calls = 0;

static int cmpCount(const void *a, const void *b) {
  calls++;
  return cmpInt(a, b);
}

int main(void) {
  /* ---- 基本的一格：int 数组 */
  int v[7] = { 5, 3, 9, 1, 7, 2, 8 };
  qsort(v, 7, sizeof(int), cmpInt);
  printf("up");
  for (int i = 0; i < 7; i++) printf(" %d", v[i]);
  printf("\n");

  qsort(v, 7, sizeof(int), cmpDown);
  printf("down");
  for (int i = 0; i < 7; i++) printf(" %d", v[i]);
  printf("\n");

  /* ---- 一个元素、零个元素：都不该动，也不该崩 */
  int one[1] = { 42 };
  qsort(one, 1, sizeof(int), cmpInt);
  qsort(one, 0, sizeof(int), cmpInt);
  printf("tiny %d\n", one[0]);

  /* ---- struct 数组：元素比一个字宽，交换是按字节做的 */
  struct rec r[4] = { { 3, 'c' }, { 1, 'a' }, { 4, 'd' }, { 2, 'b' } };
  qsort(r, 4, sizeof(struct rec), cmpRec);
  printf("rec");
  for (int i = 0; i < 4; i++) printf(" %d%c", r[i].key, r[i].tag);
  printf("\n");

  /* ---- 比较器有副作用：说明它真的在我们这边跑 */
  int w[5] = { 4, 2, 5, 1, 3 };
  qsort(w, 5, sizeof(int), cmpCount);
  printf("called %d\n", calls > 0);
  printf("sorted %d %d %d\n", w[0], w[2], w[4]);

  /* ---- bsearch：比较器的两个实参有次序（key 在前） */
  int s[6] = { 2, 4, 6, 8, 10, 12 };
  int key = 8;
  int *hit = bsearch(&key, s, 6, sizeof(int), cmpInt);
  printf("found %d %d\n", hit != NULL, hit == NULL ? -1 : (int)(hit - s));
  key = 2;
  hit = bsearch(&key, s, 6, sizeof(int), cmpInt);
  printf("first %d\n", hit == NULL ? -1 : (int)(hit - s));
  key = 12;
  hit = bsearch(&key, s, 6, sizeof(int), cmpInt);
  printf("last %d\n", hit == NULL ? -1 : (int)(hit - s));
  key = 7;
  printf("miss %d\n", bsearch(&key, s, 6, sizeof(int), cmpInt) == NULL);
  key = 2;
  printf("empty %d\n", bsearch(&key, s, 0, sizeof(int), cmpInt) == NULL);

  /* ---- 通过一个函数指针变量传比较器（不是直接写函数名） */
  int (*fp)(const void *, const void *) = cmpDown;
  qsort(s, 6, sizeof(int), fp);
  printf("viaptr %d %d\n", s[0], s[5]);

  /* `calls` 的**具体值**是算法相关的（我们是插入排序，宿主的 libc 不是），
   * 所以只问「有没有调过」，不把它算进退出码里。 */
  return v[0] + r[3].key + w[4];
}
