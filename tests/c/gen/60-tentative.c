/* 第八刀第三十九片：试探性定义（tentative definition，C11 6.9.2）。
 * tcctest.c:1462 那一段自带注释「GCC accepts that」。 */
#include <stdio.h>

/* 先来一条没写长度的，后面那条把它补上 */
static int tab_reinit[];
static int tab_reinit[10];

static int tentative_ar[];
static int tentative_ar[] = { 1, 2, 3 };

/* 全局量可以定义好几遍 */
int cinit1;
int cinit1;
int cinit2 = 5;
int cinit2;

/* 顺序反过来也行：长度先写 */
static char first_sized[4];
static char first_sized[];

int main(void)
{
    printf("reinit %d\n", (int)sizeof(tab_reinit));
    tab_reinit[3] = 7;
    printf("reinit v=%d\n", tab_reinit[3]);
    printf("ar %d: %d %d %d\n", (int)sizeof(tentative_ar),
           tentative_ar[0], tentative_ar[1], tentative_ar[2]);
    printf("cinit %d %d\n", cinit1, cinit2);
    printf("first %d\n", (int)sizeof(first_sized));
    return 0;
}
