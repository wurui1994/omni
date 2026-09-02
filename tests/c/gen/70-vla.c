/* 第八刀第四十九片：C99 的变长数组（VLA）。tcctest.c:2984 的 `c99_vla_test_1`
 * 与 3033 的 `c99_vla_test_2`（指向变长数组的指针）。 */
#include <stdio.h>
#include <stdlib.h>

int sum(int n)
{
    int a[n];
    int i, s = 0;
    for (i = 0; i < n; i++) a[i] = i * i;
    for (i = 0; i < n; i++) s += a[i];
    return s + (int)sizeof(a);
}

/* 长度在**声明那一刻**就定住了：后面改 `size` 不影响 `sizeof tab1`。 */
void two(int size1, int size2)
{
    int size = size1 * size2;
    int tab1[size][2], tab2[10][2];
    void *tab1_ptr, *tab2_ptr;

    size = size - 1;
    printf("sz %d %d\n", (int)(sizeof tab1 == size1 * size2 * 2 * sizeof(int)),
           (int)sizeof tab1);
    tab1_ptr = tab1;
    tab2_ptr = tab2;
    printf("sub %d\n", (int)(tab2 - tab1 == (tab2_ptr - tab1_ptr) / (sizeof(int) * 2)));
    printf("add %d\n", (int)(&tab1[5][1] == (tab1_ptr + (5 * 2 + 1) * sizeof(int))));
    tab1[size1][1] = 42;
    printf("acc %d\n", (int)(*((int *)(tab1_ptr + (size1 * 2 + 1) * sizeof(int))) == 42));
}

/* 循环里的那一块每一圈都要收回去 —— 不然 `$sp` 一路往下掉。`break`/`continue`/`goto`
 * 都会跳过作用域退出那条恢复，所以那三处各自要发一条。 */
int loopy(int n)
{
    int i, s = 0;
    for (i = 0; i < 2000; i++) {
        int a[n];
        a[0] = i;
        a[n - 1] = i + 1;
        s += a[0] + a[n - 1];
        if (i == 1999) break;
        continue;
    }
    return s;
}

int gotoy(int n)
{
    int i = 0, s = 0;
again:
    {
        int a[n];
        a[0] = i;
        s += a[0] + 1;
    }
    if (++i < 1000) goto again;
    return s;
}

/* 递归：每一层划一块，返回时靠收场那条把 `$sp` 还回去。 */
int rec(int n)
{
    int a[n];
    int i, s = 0;
    if (n <= 0) return 0;
    for (i = 0; i < n; i++) a[i] = n;
    for (i = 0; i < n; i++) s += a[i];
    return s + rec(n - 1);
}

/* 元素自己是变长的（`int a[2][n]`）：外面这一层也跟着变长，一格多大是运行期的乘法。 */
void inner(int n)
{
    int a[2][n];
    int i, j;
    for (i = 0; i < 2; i++)
        for (j = 0; j < n; j++) a[i][j] = i * 10 + j;
    printf("in %d %d %d %d\n", (int)sizeof a, (int)sizeof a[0], a[1][n - 1], a[0][0]);
}

/* 指向变长数组的指针。`static` 的那一条也合法 —— 存储类说的是那个**指针**，
 * 而 `[h][w]` 说的是它指向的东西（见 `vlaMode` 头上那段）。 */
void ptr(int d, int h, int w)
{
    int x, y, z, c = 1;
    int (*arr)[h][w] = malloc(sizeof(int) * d * h * w);
    static int (*starr)[h][w];

    for (z = 0; z < d; z++)
        for (y = 0; y < h; y++)
            for (x = 0; x < w; x++) arr[z][y][x] = c++;
    starr = &arr[1];
    printf("p %d %d %d\n", (int)sizeof(*arr), (int)sizeof(*arr)[0],
           (int)sizeof(*arr)[0][0]);
    printf("p %d %d %d\n", (int)(arr + 2 - arr), (int)(*arr + 3 - *arr),
           (int)(starr[0][2][3] == arr[1][2][3]));
    printf("p %d %d %d\n", arr[0][0][0], arr[2][3][4], arr[1][2][3]);
    free(arr);
}

int main(void)
{
    printf("s %d %d\n", sum(4), sum(7));
    two(5, 2);
    printf("loop %d\n", loopy(3));
    printf("goto %d\n", gotoy(2));
    printf("rec %d\n", rec(6));
    inner(3);
    ptr(3, 4, 5);
    return 0;
}
