/* **静态初始化式里的两格地址常量**（native 那条腿上都是 data 段里的重定位）。
 *
 * 一、下标是**算式**的那种：`&arr[0+2].m`。字面量下标（`&arr[2].m`）在指针算术那一层
 *     就折完了，算式下标却剩下一条 `CVT(ADD(0,2))`（`asI64` 把 int 下标加宽到 i64），
 *     而那台「把指令反着读一遍」的机器（`symConstOf`/`kfoldOf`）从前读到 `CVT` 就
 *     回 null，于是报 `initializer element is not constant`。
 *     逼出这一格的是 CPython 的 `Python/parking_lot.c:49`：那张 257 格的表全是
 *     `[0+2+1] = { .root = { &buckets[0+2+1].root, … } }`。
 *
 * 二、**带非 ASCII 字节的串**：常量池里它的种类是 `bytes` 而不是 `str`
 *     （`strConst` 按字节挑），而 `symConstOf` 从前只认 `str` —— 于是
 *     `static const char *p = "\xc2\x80";` 被判成「不是常量」。
 *     逼出这一格的是 CPython 的 latin1 单字符表（`Python/pystate.c:309` 那个
 *     巨大的 `_PyRuntimeState_INIT`）。 */
#include <stdio.h>
#include <string.h>

struct N { struct N *next; };
struct B { long pad; struct N root; };

/* 自指的表：每一格指着自己那个 root（`&buckets[i].root` 的形状） */
static struct B bs[4] = {
    [0]     = { .root = { &bs[0].root } },
    [0 + 1] = { .root = { &bs[0 + 1].root } },
    [1 + 1] = { .root = { &bs[1 + 1].root } },
    [2 + 1] = { .root = { &bs[2 + 1].root } },
};

/* 下标算式里带乘除与括号的那几种 */
static long tab[8] = { 0, 1, 2, 3, 4, 5, 6, 7 };
static long *p1 = &tab[2 * 3];
static long *p2 = &tab[(1 + 1) * 2 + 1];
static long *p3 = tab + (8 - 3);

/* 带非 ASCII 字节的串：`bytes` 那一种 */
static const char *u1 = "\xc2\x80";
static const char *u2 = "ascii";
static const char *u3 = "\xe4\xbd\xa0\xe5\xa5\xbd";
struct S { const char *s; int n; };
static struct S arr[2] = { { "\xff\xfe", 2 }, { "x", 1 } };

int main(void) {
    int ok = 1;
    for (int i = 0; i < 4; i++) ok = ok && bs[i].root.next == &bs[i].root;
    printf("%d %ld %ld %ld\n", ok, *p1, *p2, *p3);
    printf("%d %d %d %d\n", (unsigned char)u1[0], (unsigned char)u1[1],
           (unsigned char)u3[0], (int)strlen(u2));
    printf("%d %d %s\n", (unsigned char)arr[0].s[0], arr[0].n, arr[1].s);
    return 0;
}
