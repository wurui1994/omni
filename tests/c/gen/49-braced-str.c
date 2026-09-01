/* 第八刀第二十八片：花括号裹着的字符串，以及字符串字面量的下标。
 *
 * 两件事挤在同一个位置上：`{ "abc" }` 是「铺进数组」（C11 6.7.9 第 14 段），
 * 而 `{ "ab" "c"[2], 0 }` 里那个字面量只是一个更大表达式的开头。判法照 tcc ——
 * 把相邻的字面量并完之后看下一格，是 `}` `,` `;` 才算「孤零零的一个」。 */
#include <stdio.h>

char g1[] = { "ab" };
char g2[4] = { "xy" };
char *g3 = { "ptr" };
struct S { unsigned char a[3]; unsigned char b; };
struct S g4 = { "r" };
struct S g5[2] = { { "q" }, { "z", 7 } };
char g6[] = { "ab" "cd" };

int main(void) {
  printf("g: [%s] %d [%s] %d [%s] [%s] %d [%s] %d [%s] %d\n",
         g1, (int)sizeof(g1), g2, (int)sizeof(g2), g3,
         g4.a, g4.b, g5[0].a, g5[0].b, g5[1].a, g5[1].b);
  printf("g6=[%s] %d\n", g6, (int)sizeof(g6));

  /* 局部：同一段代码，落地的地方不同 */
  char l1[] = { "loc" };
  char l2[2] = { "q" };
  char l3[6] = { "ab" "cd" };
  struct S l4 = { "s", 3 };
  printf("l: [%s] %d [%s] [%s] %d [%s] %d\n",
         l1, (int)sizeof(l1), l2, l3, (int)sizeof(l3), l4.a, l4.b);

  /* 下标：并完再取。`"ab" "c"[2]` 是 `"abc"[2]`，也就是 'c' */
  char x1[2] = { "ab" "c"[2], 0 };
  char x2[] = { "ab"[1], 0 };
  int i1 = "abcde"[1];
  int i2 = "abc"[3];        /* 末尾那个 0 属于这个数组 */
  int i3 = "\xff"[0];       /* char 在这个目标上带符号 */
  printf("x: [%s] [%s] %d %d %d\n", x1, x2, i1, i2, i3);

  return (int)sizeof(g1) + (int)sizeof(l3) + i1;
}
