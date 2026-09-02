/* 第八刀第四十八片：指针的静态初始化式是一个**地址常量**。
 * tcctest.c:2900 一带（`int *rel1 = &reltab[1];`）。 */
#include <stdio.h>

int reltab[3] = { 1, 2, 3 };
int *rel1 = &reltab[1];
int *rel2 = &reltab[2];
int *rel3 = reltab + 2;
int *rel4 = reltab;

struct S { int a, b; };
struct S st = { 4, 5 };
int *rel5 = &st.b;

char *rel6 = "abcd" + 1;
char *rel7 = &"abcd"[2];

static int f(void) { return 7; }
int (*rel8)(void) = f;

int arr2[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } };
int *rel9 = arr2[1] + 1;

int main(void)
{
    printf("%d %d %d %d\n", *rel1, *rel2, *rel3, *rel4);
    printf("%d %s %s\n", *rel5, rel6, rel7);
    printf("%d %d\n", rel8(), *rel9);
    return 0;
}
