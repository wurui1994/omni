/* 第八刀第五十片：形参上的变长数组，以及类型名里的变长数组。
 * tcctest.c:3071 的 `c99_vla_test_3a`-`3e` 与 3162 的 `sizeof(char[1+2*a])`。 */
#include <stdio.h>

/* 最外面那一维退化成指针（`int (*)[3][4]`），里面那些维度的长度在**进函数时**才算。 */
void a3(int arr[2][3][4])
{
    printf("%d %d %d\n", (int)sizeof(*arr), (int)sizeof((*arr)[0]), arr[1][2][3]);
}

void b3(int s, int arr[s][3][4])
{
    printf("%d %d %d\n", (int)sizeof(*arr), (int)sizeof((*arr)[0]), arr[1][2][3]);
}

void c3(int s, int arr[2][s][4])
{
    printf("%d %d %d\n", (int)sizeof(*arr), (int)sizeof((*arr)[0]), arr[1][2][3]);
}

void d3(int s, int arr[2][3][s])
{
    printf("%d %d %d\n", (int)sizeof(*arr), (int)sizeof((*arr)[0]), arr[1][2][3]);
}

/* 那段记号是**真的求值**：`--s` 会把 s 减一。 */
void e3(int s, int arr[][3][--s])
{
    printf("%d %d %d %d\n", (int)sizeof(*arr), (int)sizeof((*arr)[0]), arr[1][2][3], s);
}

/* 原型（没有函数体）里的那一种：长度只是读一遍就丢。 */
void proto(int n, int a[n][2]);
void proto(int n, int a[n][2])
{
    printf("%d %d\n", (int)sizeof(*a), a[n - 1][1]);
}

int main(void)
{
    int a[2][3][4];
    int b[3][2];
    int i, j, k, c = 0, x = 2;

    for (i = 0; i < 2; i++)
        for (j = 0; j < 3; j++)
            for (k = 0; k < 4; k++) a[i][j][k] = c++;
    for (i = 0; i < 3; i++)
        for (j = 0; j < 2; j++) b[i][j] = i * 2 + j;

    a3(a);
    b3(2, a);
    c3(3, a);
    d3(4, a);
    e3(5, a);
    proto(3, b);

    /* 类型名里的变长数组：长度**要真的算**，哪怕它长在 `sizeof` 里面。 */
    printf("t %d %d\n", (int)sizeof(char[1 + 2 * x]), (int)sizeof(int[x][3]));
    printf("x %d\n", x);
    return 0;
}
