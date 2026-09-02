/* 第八刀第六十一片：typedef 上的 aligned(N)（属性跟着名字走）。 */
#include <stdio.h>

typedef unsigned long long __attribute__((aligned(4))) unaligned_u64;
typedef unaligned_u64 chained_u64;
typedef int __attribute__((aligned(16))) overaligned_int;

struct A { unsigned int n; unaligned_u64 v; };
struct B { unsigned int n; chained_u64 v; };
struct C { unsigned int n; unsigned long long v; };
struct D { char c; overaligned_int i; };
struct E { unsigned int n; unaligned_u64 v __attribute__((aligned(8))); };

unaligned_u64 g;
overaligned_int gi;

int main(void)
{
    struct A a;
    printf("A %d %d\n", (int)sizeof(struct A), (int)__alignof__(struct A));
    printf("B %d %d\n", (int)sizeof(struct B), (int)__alignof__(struct B));
    printf("C %d %d\n", (int)sizeof(struct C), (int)__alignof__(struct C));
    printf("D %d %d\n", (int)sizeof(struct D), (int)__alignof__(struct D));
    printf("E %d %d\n", (int)sizeof(struct E), (int)__alignof__(struct E));
    printf("t %d %d %d\n", (int)sizeof(unaligned_u64), (int)__alignof__(unaligned_u64),
           (int)__alignof__(overaligned_int));
    printf("off %d %d\n", (int)__builtin_offsetof(struct A, v),
           (int)__builtin_offsetof(struct C, v));
    a.n = 7;
    a.v = 0x1122334455667788ULL;
    printf("v %u %llx\n", a.n, a.v);
    g = 5;
    gi = 6;
    printf("g %llu %d\n", g, gi);
    return 0;
}
