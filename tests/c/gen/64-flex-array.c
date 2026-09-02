/* 第八刀第四十三片：柔性数组成员（C11 6.7.2.1 第 18 段）与它那两种老写法。
 * 占 0 个字节，但照样抬整体的对齐。tcctest.c:1783 那一格。 */
#include <stdio.h>
#include <string.h>

struct f0 { int n; char buf[]; };      /* 标准写的那一种 */
struct f1 { int n; char buf[0]; };     /* GNU 的长度 0 */
struct f2 { int n; char buf[1]; };     /* 更老的「留一格」写法 —— 这一种是真占 1 个字节 */
struct f3 { int n; int v[]; };
struct f4 { char c; double d[]; };     /* 对齐由它说了算：sizeof 是 8 */

static char store[64];

int main(void)
{
    printf("sz %d %d %d %d %d\n", (int)sizeof(struct f0), (int)sizeof(struct f1),
           (int)sizeof(struct f2), (int)sizeof(struct f3), (int)sizeof(struct f4));
    struct f0 *p = (struct f0 *)store;
    p->n = 3;
    strcpy(p->buf, "abc");
    printf("p %d %s %d\n", p->n, p->buf, (int)((char *)p->buf - (char *)p));
    struct f3 *q = (struct f3 *)store;
    q->v[0] = 11;
    q->v[1] = 22;
    printf("q %d %d %d\n", q->v[0], q->v[1], (int)((char *)q->v - (char *)q));
    struct f0 init = { 5 };
    printf("i %d\n", init.n);
    return 0;
}
