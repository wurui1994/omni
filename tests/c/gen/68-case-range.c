/* 第八刀第四十七片：`case 1 ... 5:` —— GNU 的范围。tcctest.c:1968 那一格。
 * 密的走跳转表（一格一格填），稀的走**一次**无符号区间比较。 */
#include <stdio.h>

static int f(int x)
{
    switch (x) {
    case 1 ... 5: return 10;
    case 7: return 20;
    case 100 ... 100: return 30;          /* 长度 1 的范围 */
    case 1000 ... 100000: return 40;      /* 稀疏：一条比较，不是十万条 */
    default: return -1;
    }
}

static int g(char c)
{
    switch (c) {
    case 'a' ... 'z': return 1;
    case 'A' ... 'Z': return 2;
    case '0' ... '9': return 3;
    }
    return 0;
}

int main(void)
{
    int i;
    for (i = 0; i < 9; i++) printf("%d ", f(i));
    printf("| %d %d %d %d\n", f(100), f(999), f(1000), f(100000));
    printf("g %d %d %d %d\n", g('q'), g('Q'), g('7'), g('+'));
    return 0;
}
