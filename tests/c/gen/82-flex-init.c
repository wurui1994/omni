/* 第八刀第六十二片：柔性数组成员配初始化式 —— sizeof 不变，占的地方要够大。 */
#include <stdio.h>

struct S { int a; int b[]; };
struct S c20;
struct S c21 = { .a = 3000, .b = { 3001, 3002, 3003 } };
struct S c22 = { .a = 4000, .b = { 4001, 4002, 4003, 4004, 4005, 4006 } };
struct S c23 = { 5000 };
int tail1[3] = { 9, 8, 7 };

struct T { char c; char s[]; };
struct T t1 = { 'x', "abcdef" };
struct T t2 = { 'y', { 'a', 'b' } };
int tail2[2] = { 6, 5 };

typedef int arr[];
arr s19;
arr s19 = { 1 };
int tail3 = 4;

int main(void)
{
    struct S l = { .a = 1, .b = { 11, 12, 13, 14 } };
    printf("c21 %d %d %d %d\n", c21.a, c21.b[0], c21.b[1], c21.b[2]);
    printf("c22 %d %d %d\n", c22.a, c22.b[0], c22.b[5]);
    printf("c23 %d\n", c23.a);
    printf("t1 %c %s\n", t1.c, t1.s);
    printf("t2 %c %c%c\n", t2.c, t2.s[0], t2.s[1]);
    printf("tail1 %d %d %d\n", tail1[0], tail1[1], tail1[2]);
    printf("tail2 %d %d\n", tail2[0], tail2[1]);
    printf("s19 %d, tail3 %d\n", s19[0], tail3);
    printf("sz %d %d %d %d\n", (int)sizeof c20, (int)sizeof c21,
           (int)sizeof(struct S), (int)sizeof(struct T));
    printf("l %d %d %d %d %d\n", l.a, l.b[0], l.b[1], l.b[2], l.b[3]);
    printf("d %d %d %d\n", (int)((char *)&c22 - (char *)&c21),
           (int)((char *)tail1 - (char *)&c23),
           (int)((char *)tail2 - (char *)&t2));
    return 0;
}
