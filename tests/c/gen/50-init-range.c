/* 第八刀第二十九片：范围指定初始化器 `[a ... b] =`（GNU 扩展）。
 * tcctest.c:378 那一格（`struct str_SS ss = { { [0 ... 1] = 'a' }, 0 };`）在这儿，
 * 静态与自动两侧都走一遍：标量、char、struct、指针，还有「初始化式只求值一遍」。 */
#include <stdio.h>

int gi[10] = { [2 ... 5] = 20, [8] = 9 };
char gc[8] = { [1 ... 3] = 'x', [6 ... 7] = 'y' };
struct P { int a; int b; };
struct P gp[4] = { [1 ... 2] = { 7, 8 } };
/* 指针那一格：字符串本身在 data 段另一处、是共享的，只有那 8 个字节跟着复制。 */
char *gs[4] = { [0 ... 1] = "BB", [2 ... 3] = "CC" };
int gnest[2][3] = { [1] = { [0 ... 2] = 5 } };

struct str_SS { char s[4]; int n; };

int calls;
int f(void) { calls++; return 5; }

int main(void)
{
    int i, j;
    int a[10] = { [2 ... 5] = 20, [8] = 9 };
    char c[8] = { [1 ... 3] = 'x', [6 ... 7] = 'y' };
    struct P p[4] = { [1 ... 2] = { 7, 8 } };
    struct str_SS ss = { { [0 ... 1] = 'a' }, 0 };
    /* tcc 把初始化式**求一遍**、再复制字节 —— 所以 f 只叫一次，不是四次。 */
    int one[4] = { [0 ... 3] = f() };
    int mixed[6] = { 1, [2 ... 3] = 4, 5 };
    int single[3] = { [0 ... 0] = 7 };
    static int st[5] = { [1 ... 4] = 3 };

    for (i = 0; i < 10; i++) printf("gi[%d]=%d a[%d]=%d\n", i, gi[i], i, a[i]);
    for (i = 0; i < 8; i++) printf("gc[%d]=%d c[%d]=%d\n", i, gc[i], i, c[i]);
    for (i = 0; i < 4; i++)
        printf("gp[%d]={%d,%d} p[%d]={%d,%d}\n", i, gp[i].a, gp[i].b, i, p[i].a, p[i].b);
    for (i = 0; i < 4; i++) printf("gs[%d]=%s\n", i, gs[i]);
    for (i = 0; i < 2; i++)
        for (j = 0; j < 3; j++) printf("gnest[%d][%d]=%d\n", i, j, gnest[i][j]);
    printf("ss=%d,%d,%d,%d n=%d\n", ss.s[0], ss.s[1], ss.s[2], ss.s[3], ss.n);
    for (i = 0; i < 4; i++) printf("one[%d]=%d\n", i, one[i]);
    printf("calls=%d\n", calls);
    for (i = 0; i < 6; i++) printf("mixed[%d]=%d\n", i, mixed[i]);
    for (i = 0; i < 3; i++) printf("single[%d]=%d\n", i, single[i]);
    for (i = 0; i < 5; i++) printf("st[%d]=%d\n", i, st[i]);
    return 0;
}
