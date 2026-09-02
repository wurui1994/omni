/* 第八刀第三十七片：`switch` 的体不是花括号（C11 6.8.4：`switch (expr) statement`）。
 * tcctest.c:1352 自己带注释考这一格。 */
#include <stdio.h>

int one(void) { return 1; }

int main(void)
{
    int j = 1;
    int n = 0;
    int i;

    /* tcctest.c 那一格：整个体就是一条带标签的语句 */
    switch (j)
        case 1: break;
    printf("a ok\n");

    /* 体是一条语句、而且真的会跑到 */
    switch (j)
        case 1: printf("b hit\n");

    /* default 也能当那一条 */
    switch (7)
        default: printf("c default\n");

    /* 一个都不匹配：整条 switch 什么都不做 */
    switch (2)
        case 1: printf("d NOT\n");
    printf("d ok\n");

    /* 体是一条**复合**语句以外的东西，里头还有 else 与 do/while */
    switch (j)
        case 1: if (one()) printf("e then\n"); else printf("e else\n");
    switch (j)
        case 1: do { n++; } while (n < 3);
    printf("n=%d\n", n);

    /* 里层的 switch 体不是花括号：外层扫标签时要整块跳过它 */
    switch (j) {
    case 1:
        switch (2)
            case 2: printf("f inner\n");
        break;
    case 2:
        printf("f NOT\n");
        break;
    }

    /* 在循环里，break 归 switch */
    for (i = 0; i < 3; i++)
        switch (i)
            case 1: n += 10;
    printf("n=%d\n", n);
    return 0;
}
