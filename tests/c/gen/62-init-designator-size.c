/* 第八刀第四十一片：不定长数组配指定初始化器 —— 长度由「见过的最大格号 + 1」定。
 * tcctest.c:1474 那一条（`[0 ... 1] = "BB"`）就是这一格。 */
#include <stdio.h>

char const *const cinit8[] = { [0 ... 1] = "BB", [2 ... 4] = "CC" };
int t1[] = { [3] = 1 };
int t2[] = { [4] = 5, [0] = 1 };        /* 往回跳：长度还是 5 */
int t3[] = { 1, [4] = 5, 6 };           /* 指定之后接着往下排 */

struct S { int a, b; };
struct S t4[] = { [1].b = 7, [0].a = 1 };
int t5[][2] = { [1] = { 3, 4 } };
int t6[] = { [2 ... 4] = 9 };

int main(void)
{
    int i;
    printf("c8 %d:", (int)(sizeof(cinit8) / sizeof(cinit8[0])));
    for (i = 0; i < 5; i++) printf(" %s", cinit8[i]);
    printf("\n");
    printf("t1 %d %d\n", (int)sizeof(t1), t1[3]);
    printf("t2 %d %d %d\n", (int)sizeof(t2), t2[0], t2[4]);
    printf("t3 %d %d %d %d\n", (int)sizeof(t3), t3[0], t3[4], t3[5]);
    printf("t4 %d %d %d\n", (int)sizeof(t4), t4[0].a, t4[1].b);
    printf("t5 %d %d %d\n", (int)sizeof(t5), t5[1][0], t5[1][1]);
    printf("t6 %d %d %d\n", (int)sizeof(t6), t6[2], t6[4]);
    int loc[] = { [3] = 4, [1] = 2 };
    printf("loc %d %d %d\n", (int)sizeof(loc), loc[1], loc[3]);
    return 0;
}
