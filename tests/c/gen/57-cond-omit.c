/* 第八刀第三十六片：省掉中间那一项的 `? :`（GNU 扩展，tcctest.c:1303 那一段）。
 * `x ? : y` = 「x 非 0 就是 x，否则 y」，而 x **只求值一次**。 */
#include <stdio.h>

static int v1 = 34 ? : -1;      /* 常量那一路 */
static int v2 = 0 ? : -1;
static int v3 = (2 - 2) ? : 7;

int calls;

int f(int x)
{
    calls++;
    return x;
}

int main(void)
{
    int a = 30;
    double d = 0.0;
    char *p = 0;
    char *q = "hi";
    unsigned u = 0;

    printf("%d %d %d\n", v1, v2, v3);
    printf("%d %d\n", a - 30 ? : a * 2, a + 1 ? : a * 2);
    /* 只求值一次：真的那一支不该把 f 再叫一遍 */
    calls = 0;
    printf("nz=%d calls=%d\n", f(5) ? : 99, calls);
    calls = 0;
    printf("z=%d calls=%d\n", f(0) ? : 99, calls);
    /* 浮点与指针 */
    printf("d=%g %g\n", d ? : 1.5, 2.5 ? : 1.5);
    printf("p=%s %s\n", p ? : "null", q ? : "null");
    printf("u=%d\n", u ? : 42);
    /* 嵌套与当条件用 */
    printf("nest=%d\n", 0 ? : 0 ? : 3);
    if (a - 30 ? : 1) printf("cond ok\n");
    /* 副作用只发生一次 */
    calls = 0;
    a = f(0) ? : f(7);
    printf("a=%d calls=%d\n", a, calls);
    return 0;
}
