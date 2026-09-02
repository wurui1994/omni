/* 第八刀第三十四片：`__attribute__((aligned(N)))` 与 `packed`（tcctest.c:988 那一段）。
 * 对齐既能加大（aligned）也能压掉（packed），而且两个位置都得认：tag 之前与 `}` 之后。
 * 对齐量不出来只能靠 offset —— 用一个 `char` 打头的探针结构体去问。 */
#include <stdio.h>

struct __attribute__((aligned(16))) a5 { int i; };
struct a6 { int i; } __attribute__((aligned(16)));
struct a7 { int i; };

/* packed：成员一律按 1 排 */
struct p1 { char c; int i; short s; } __attribute__((packed));
/* packed 之后再抬整体的对齐：成员还是紧排，外壳按 4 */
struct p2 { char c; int i; } __attribute__((packed, aligned(4)));
/* 成员自己带 aligned：只影响那一个成员的位置 */
struct m1 { char c; int i __attribute__((aligned(8))); char d; };
/* 属性长在说明符那一段上：管这一行的所有声明符 */
struct m2 { char c; __attribute__((aligned(8))) int i, j; };
/* 常量表达式当对齐量 */
struct a9 { int i; } __attribute__((aligned(2 * sizeof(long))));
/* union 也走同一条路 */
union u1 { char c; int i; } __attribute__((aligned(32)));

/* 对齐的探针：前面一个 char，后面那个成员的 offset 就是它的对齐 */
struct probe5 { char c; struct a5 s; };
struct probe6 { char c; struct a6 s; };
struct probe7 { char c; struct a7 s; };
struct probe9 { char c; struct a9 s; };
struct probeu { char c; union u1 s; };
struct probep2 { char c; struct p2 s; };

struct a5 g5[2];
struct a6 g6[2];
/* 属性挂在**变量**上：抬的是这一个符号的地址，不是类型（tcctest.c:1007） */
struct a7 g7[2] __attribute__((aligned(16)));
char gpad;
int g32 __attribute__((aligned(32))) = 9;

int main(void)
{
    struct p1 p;
    struct m1 m;
    char lpad;
    int l16 __attribute__((aligned(16)));

    printf("a5 %d %d\n", (int)sizeof(struct a5), (int)__builtin_offsetof(struct probe5, s));
    printf("a6 %d %d\n", (int)sizeof(struct a6), (int)__builtin_offsetof(struct probe6, s));
    printf("a7 %d %d\n", (int)sizeof(struct a7), (int)__builtin_offsetof(struct probe7, s));
    printf("a9 %d %d\n", (int)sizeof(struct a9), (int)__builtin_offsetof(struct probe9, s));
    printf("u1 %d %d\n", (int)sizeof(union u1), (int)__builtin_offsetof(struct probeu, s));
    printf("p1 %d: %d %d %d\n", (int)sizeof(struct p1),
           (int)__builtin_offsetof(struct p1, c),
           (int)__builtin_offsetof(struct p1, i),
           (int)__builtin_offsetof(struct p1, s));
    printf("p2 %d %d: %d %d\n", (int)sizeof(struct p2),
           (int)__builtin_offsetof(struct probep2, s),
           (int)__builtin_offsetof(struct p2, c),
           (int)__builtin_offsetof(struct p2, i));
    printf("m1 %d: %d %d %d\n", (int)sizeof(struct m1),
           (int)__builtin_offsetof(struct m1, c),
           (int)__builtin_offsetof(struct m1, i),
           (int)__builtin_offsetof(struct m1, d));
    printf("m2 %d: %d %d %d\n", (int)sizeof(struct m2),
           (int)__builtin_offsetof(struct m2, c),
           (int)__builtin_offsetof(struct m2, i),
           (int)__builtin_offsetof(struct m2, j));
    /* 紧排的成员真的能读写（未对齐的访问） */
    p.c = 'x';
    p.i = 0x11223344;
    p.s = -2;
    printf("p1 vals %c %x %d\n", p.c, p.i, p.s);
    m.c = 'y';
    m.i = 7;
    m.d = 'z';
    printf("m1 vals %c %d %c\n", m.c, m.i, m.d);
    printf("g5 %d g6 %d\n", (int)sizeof(g5), (int)sizeof(g6));
    /* 符号上的对齐只能问地址：低位必须是 0（gpad 那个 char 就是为了把它顶歪） */
    printf("sym %d %d %d\n", (int)((unsigned long)(void *)g7 & 15),
           (int)((unsigned long)(void *)&g32 & 31),
           (int)((unsigned long)(void *)&l16 & 15));
    lpad = 'q';
    l16 = 3;
    printf("sym vals %c %d\n", lpad, l16);
    return 0;
}
