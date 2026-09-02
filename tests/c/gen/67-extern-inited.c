/* 第八刀第四十六片：文件作用域上 `extern int x = 1;` 是一条**定义**。
 * tcctest.c:1827 那一条（`extern int external_inited = 42;`）。 */
#include <stdio.h>

extern int external_inited = 42;
extern int ei2;
int ei2 = 5;
extern char es[] = "hi";

int main(void)
{
    printf("%d %d %s %d\n", external_inited, ei2, es, (int)sizeof(es));
    return 0;
}
