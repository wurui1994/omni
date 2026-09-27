/* **`_Alignas`**（C11 6.7.5）：一位说明符，落在与 `__attribute__((aligned(N)))`
 * 同一格上。括号里可以是**数**（正的 2 的幂）也可以是**类型名**（取那个类型的对齐）。
 *
 * 逼出这一格的是 CPython：`Include/object.h:145` 的
 * `_Py_ALIGNED_DEF(_PyObject_MIN_ALIGNMENT, char) _aligner;` 展开成
 * `_Alignas(N) char _aligner;`。那一支只在 `__STDC_VERSION__ >= 201112L` 上走到，
 * 所以要先有 `-std=c11`（`cpp/10-std.c` 那一格）才撞得见它 —— 两刀是一对。 */
#include <stdio.h>

struct S { int a; _Alignas(16) char c; };
/* 类型名那一种：`_Alignas(double)` = 8 */
struct T { _Alignas(double) char d; };
/* 与 `aligned(N)` 写在一起时是同一格（后写的赢，与 tcc 一样） */
struct U { int a; char b __attribute__((aligned(8))); };

_Alignas(32) static char buf[4];
_Alignas(16) static int gi = 7;

int main(void) {
    _Alignas(16) char loc[3];
    printf("%d %d %d %d\n", (int)sizeof(struct S), (int)_Alignof(struct S),
           (int)_Alignof(struct T), (int)_Alignof(struct U));
    /* 真的落在对齐边界上（这一问比 `_Alignof` 硬：它看的是分配出来的地址） */
    printf("%d %d %d\n", (int)(((unsigned long)buf) % 32 == 0),
           (int)(((unsigned long)&gi) % 16 == 0), (int)(((unsigned long)loc) % 16 == 0));
    printf("%d %d\n", gi, (int)sizeof(buf));
    return 0;
}
