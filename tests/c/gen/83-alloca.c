/* 第八刀第六十三片：alloca —— 在 $sp 上切一刀，活到函数返回。 */
#include <stdio.h>
#include <string.h>

void alloca_test(void)
{
    char *p = alloca(16);
    strcpy(p, "123456789012345");
    printf("alloca: p is %s\n", p);
    char *demo = "This is only a test.\n";
    /* Test alloca embedded in a larger expression */
    printf("alloca: %s\n", strcpy(alloca(strlen(demo) + 1), demo));
}

/* 递归：每一层切一块，返回时还回去 —— 收场那一条要真的在，不然栈一路往下掉。 */
int rec(int n)
{
    char *p = alloca(64);
    p[0] = (char)n;
    return n ? p[0] + rec(n - 1) : 0;
}

/* 一个作用域里切好几块，块与块之间不许重叠。 */
int spread(void)
{
    int i;
    int *a = alloca(4 * sizeof(int));
    int *b = alloca(4 * sizeof(int));
    for (i = 0; i < 4; i++) { a[i] = i + 1; b[i] = 100 + i; }
    return a[0] + a[3] + b[0] + b[3] - (a == b ? 1000 : 0);
}

/* 循环里切：C 的语义是「函数返回才还」，所以这是一路往下切 —— 只要别切爆。 */
int loop(void)
{
    int i;
    int s = 0;
    for (i = 0; i < 500; i++) {
        char *q = alloca(32);
        q[0] = (char)(i & 7);
        s += q[0];
    }
    return s;
}

int main(void)
{
    double *d;
    alloca_test();
    d = alloca(sizeof(double));
    d[0] = 10.0;
    printf("d %g\n", d[0]);
    printf("rec %d\n", rec(20));
    printf("spread %d\n", spread());
    printf("loop %d\n", loop());
    printf("bi %d\n", (int)(__builtin_alloca(8) != 0));
    printf("again %d\n", rec(5));
    return 0;
}
