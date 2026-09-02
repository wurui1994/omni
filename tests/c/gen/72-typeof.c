/* 第八刀第五十一、五十二片：GNU 的 `typeof` 与块局部标签声明 `__label__`。
 * tcctest.c:3185 一带与 3262。 */
#include <stdio.h>

int gv = 7;
typeof(gv) gv2 = 8;
__typeof__(int *) gp = &gv;

int main(void)
{
    int a = 3;
    typeof(a) b = 4;
    typeof(int) c = 5;
    typeof(&a) p = &a;
    int arr[4] = { 1, 2, 3, 4 };
    typeof(arr) arr2 = { 5, 6, 7, 8 };
    unsigned char uc = 200;
    __typeof(uc) uc2 = 201;
    double d = 1.5;
    int i = 0, s = 0;

    printf("t %d %d %d\n", (int)sizeof(typeof(int)), (int)sizeof(typeof(a)),
           (int)sizeof(typeof(arr)));
    printf("v %d %d %d %d\n", b, c, *p, arr2[3]);
    printf("g %d %d %d\n", gv, gv2, *gp);
    printf("u %d %d\n", uc2, (int)sizeof(typeof(uc)));
    printf("c %d %d\n", (int)(typeof(a))d, (int)sizeof((typeof(d))a));
    /* 表达式那一种**不求值**：`a++` 只是被读了一遍类型 */
    printf("n %d %d\n", (int)sizeof(typeof(a++)), a);
    printf("s %d\n", (int)sizeof(typeof(*(char (*)[7])0)));

    {
        __label__ again, done;
    again:
        s += ++i;
        if (i < 5) goto again;
        goto done;
    done:
        printf("l %d %d\n", i, s);
    }
    return 0;
}
