/* 第八刀第五十九片：枚举的底层整型（全非负就是无符号，装不下 int/unsigned 就撑到 64 位）。 */
#include <stdio.h>

enum EA { A0, A1 = 3 };                                 /* 全非负 -> unsigned int */
enum EB { B0 = -1, B1 = 5 };                            /* 有负的 -> int */
enum EC { C0 = 0xf0000000u };                           /* 全非负、装得进 unsigned */
enum ED { D0 = ((unsigned long)0xf000 << 31) << 1 };    /* 装不进 unsigned -> u64 */
enum EE { E0 = -1, E1 = 0x100000000LL };                /* 有负的、装不进 int -> i64 */
enum EF { F0 };                                         /* 空的那一头：也是无符号 */

struct S { enum EA a; enum ED d; };

int main(void)
{
    printf("sz %d %d %d %d %d %d\n", (int)sizeof(enum EA), (int)sizeof(enum EB),
           (int)sizeof(enum EC), (int)sizeof(enum ED), (int)sizeof(enum EE),
           (int)sizeof(enum EF));
    printf("al %d %d\n", (int)__alignof__(enum EA), (int)__alignof__(enum ED));
    printf("st %d %d\n", (int)sizeof(struct S), (int)__builtin_offsetof(struct S, d));
    printf("uns %d %d %d\n", (enum EA)-1 > 0, (enum EB)-1 > 0, (enum ED)-1 > 0);
    printf("big %ld %llu\n", (long)D0, (unsigned long long)D0);
    printf("neg %lld %lld\n", (long long)E0, (long long)E1);
    printf("c0 %u %d\n", C0, C0 > 0);
    printf("cmp %d %d %d %d\n",
           __builtin_types_compatible_p(enum EA, unsigned int),
           __builtin_types_compatible_p(enum EA, int),
           __builtin_types_compatible_p(enum EB, int),
           __builtin_types_compatible_p(enum ED, unsigned long));
    printf("v %d %d\n", A1, B0);
    return 0;
}
