/* 第八刀第四十四片：常量表达式里 `||` / `&&` / `? :` 也短路 ——
 * 没求值的那一半里除以零不算错。tcctest.c:1813 的注释原话：
 * 「exception in constant but unevaluated context」。 */
#include <stdio.h>

int a1 = 2 || 1 / 0;
int a2 = 0 && 1 / 0;
int a3 = 1 ? 3 : 1 / 0;
int a4 = 0 ? 1 / 0 : 4;
int a5[2 || 1 / 0];                     /* 数组维度上同一条规则 */
int a6 = 0 || 2 || 1 / 0;               /* 前面那一格定下来之后，后面整段都不算 */
int a7 = 1 && 0 && 1 / 0;

int main(void)
{
    printf("%d %d %d %d %d %d %d\n", a1, a2, a3, a4,
           (int)(sizeof(a5) / sizeof(a5[0])), a6, a7);
    return 0;
}
