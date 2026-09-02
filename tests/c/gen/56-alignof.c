/* 第八刀第三十五片：`__alignof__` / `_Alignof`（tcctest.c:1094 那一段）。
 * 与 `sizeof` 同一个形状（类型名或者表达式），回的是对齐；挂了 aligned 的**符号**
 * 问出来的是符号那一份，不是类型那一份（tcc 的 `vtop[1].sym` 那个 hack）。 */
#include <stdio.h>

struct a1 { int i; };
struct a2 { int a; char b[10]; };
struct a3 { double a, b; };
struct a4 { double a[0]; };
struct __attribute__((aligned(16))) a5 { int i; };
struct a6 { int i; } __attribute__((aligned(16)));
struct a7 { char c; int i; short s; } __attribute__((packed));
struct empty { };

struct a5 alt5[2];
struct a1 alt7[2] __attribute__((aligned(16)));
int gi;
double gd;
char gc __attribute__((aligned(8)));

int main(void)
{
    int li;
    char lc[3];

    printf("t %d %d %d %d\n", (int)__alignof__(char), (int)__alignof__(short),
           (int)__alignof__(int), (int)__alignof__(double));
    printf("p %d %d\n", (int)__alignof__(char *), (int)__alignof__(long long));
    printf("s %d %d %d %d\n", (int)__alignof__(struct a1), (int)__alignof__(struct a2),
           (int)__alignof__(struct a3), (int)__alignof__(struct a4));
    printf("s2 %d %d %d\n", (int)__alignof__(struct a5), (int)__alignof__(struct a6),
           (int)__alignof__(struct a7));
    printf("empty %d\n", (int)__alignof__(struct empty));
    printf("arr %d %d\n", (int)__alignof__(struct a5[2]), (int)__alignof__(int[7]));
    /* 表达式当操作数（不求值） */
    printf("e %d %d %d\n", (int)__alignof__(gi), (int)__alignof__(gd + 1),
           (int)__alignof__(li));
    printf("lc %d\n", (int)__alignof__(lc));
    /* 符号自己的对齐 */
    printf("sym %d %d %d\n", (int)__alignof__(alt5), (int)__alignof__(alt7),
           (int)__alignof__(gc));
    /* C11 的拼法与 sizeof 混着算 */
    printf("c11 %d %d\n", (int)_Alignof(struct a3),
           (int)(sizeof(struct a2) / _Alignof(struct a2)));
    return 0;
}
