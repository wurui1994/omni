/* 第八刀第四十五片：静态位域的初始化式 —— 按位往 data 段里并。
 * tcctest.c:1817 那一段（`.bit = 1` / `.c.bit = 1` / `.c[1].bit = 1`）。 */
#include <stdio.h>

struct bf_SS { unsigned int bit:1, bits31:31; };
struct bf_SS bf_init = { .bit = 1 };
struct bf_SS bf_init2 = { 1, 7 };

struct bfn_SS { int a, b; struct bf_SS c; int d, e; };
struct bfn_SS bfn_init = { .c.bit = 1 };

struct bfa_SS { int a, b; struct bf_SS c[3]; int d, e; };
struct bfa_SS bfa_init = { .c[1].bit = 1, .c[2].bits31 = 5 };

/* 同一个字节里两个位域 + 一个普通成员 */
struct mix { char a:3; char b:2; int n; };
struct mix m1 = { .a = 3, .b = 1, .n = 9 };

int main(void)
{
    printf("1 %d %d\n", bf_init.bit, bf_init.bits31);
    printf("2 %d %d\n", bf_init2.bit, bf_init2.bits31);
    printf("3 %d %d %d\n", bfn_init.c.bit, bfn_init.a, bfn_init.d);
    printf("4 %d %d %d\n", bfa_init.c[1].bit, bfa_init.c[2].bits31, bfa_init.c[0].bit);
    printf("5 %d %d %d %d\n", m1.a, m1.b, m1.n, (int)sizeof(struct mix));
    return 0;
}
