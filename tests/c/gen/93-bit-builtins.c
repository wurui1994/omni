/* **位计数那一族的内建**（`ffs` / `clz` / `ctz` / `clrsb` / `popcount` / `parity`，
 * 各有 int / long / long long 三个宽度，一共十八个）。
 *
 * tcc 把它们写成 libtcc1 里的真函数（`lib/builtin.c`，de Bruijn 查表）；我们落成宏
 * （无表 SWAR，实参靠语句表达式只求值一次，见 `tccdefs.js` 那一段注）。
 * 所以这份用例既在考"算得对不对"，也在考"实参只求值一次"。
 *
 * 逼出这一族的是 CPython：`dictobject.c:8609`（`clzl`）、`unicodeobject.c:15436`
 * （`ctzll`）、`hamt.c:2897` 与 `longobject.c:7008`（`popcount`）。从前它们只是
 * "隐式声明"的警告 —— 那意味着链接那天才炸。
 *
 * **不考 x == 0 的 clz / ctz**：那两格 C 与 GCC 都说未定义，tcc 的查表版给
 * `clz(0)=31/63`、`ctz(0)=0`，我们给位宽。`ffs(0)` 与 `clrsb(0)` 有定义，两边一样，考。 */
#include <stdio.h>

static int calls = 0;

/* 实参只求值一次的探针：它每被求值一次就把 `calls` 加一 */
static unsigned int tick(unsigned int v) {
    calls++;
    return v;
}

int main(void) {
    /* popcount：32 位与 64 位 */
    printf("%d %d %d %d\n", __builtin_popcount(0u), __builtin_popcount(1u),
           __builtin_popcount(0xffffffffu), __builtin_popcount(0x80000001u));
    printf("%d %d %d\n", __builtin_popcountll(0ull), __builtin_popcountll(~0ull),
           __builtin_popcountll(0x8000000000000001ull));
    printf("%d %d\n", __builtin_popcountl(0ul), __builtin_popcountl(~0ul));

    /* parity */
    printf("%d %d %d %d\n", __builtin_parity(0u), __builtin_parity(1u),
           __builtin_parity(3u), __builtin_parityll(0x8000000000000001ull));

    /* ctz / clz（都不带 0） */
    printf("%d %d %d %d\n", __builtin_ctz(1u), __builtin_ctz(8u),
           __builtin_ctz(0x80000000u), __builtin_ctz(0xffffffffu));
    printf("%d %d %d\n", __builtin_ctzll(1ull), __builtin_ctzll(1ull << 40),
           __builtin_ctzll(1ull << 63));
    printf("%d %d\n", __builtin_ctzl(1ul), __builtin_ctzl(1ul << 20));
    printf("%d %d %d %d\n", __builtin_clz(1u), __builtin_clz(2u),
           __builtin_clz(0x80000000u), __builtin_clz(0xffffffffu));
    printf("%d %d %d\n", __builtin_clzll(1ull), __builtin_clzll(1ull << 40),
           __builtin_clzll(~0ull));
    printf("%d %d\n", __builtin_clzl(1ul), __builtin_clzl(~0ul));

    /* ffs（0 有定义：回 0） */
    printf("%d %d %d %d\n", __builtin_ffs(0), __builtin_ffs(1),
           __builtin_ffs(8), __builtin_ffs(0x80000000));
    printf("%d %d\n", __builtin_ffsll(0ll), __builtin_ffsll(1ll << 40));
    printf("%d %d\n", __builtin_ffsl(0l), __builtin_ffsl(1l << 20));

    /* clrsb（0 有定义：位宽 - 1） */
    printf("%d %d %d %d\n", __builtin_clrsb(0), __builtin_clrsb(1),
           __builtin_clrsb(-1), __builtin_clrsb(0x40000000));
    printf("%d %d %d\n", __builtin_clrsbll(0ll), __builtin_clrsbll(-1ll),
           __builtin_clrsbll(1ll << 40));
    printf("%d %d\n", __builtin_clrsbl(0l), __builtin_clrsbl(-1l));

    /* 实参只求值一次：六族各来一次，`calls` 该正好是 6 */
    calls = 0;
    int s = __builtin_popcount(tick(7u)) + __builtin_ctz(tick(8u))
        + __builtin_clz(tick(1u)) + __builtin_ffs((int)tick(8u))
        + __builtin_clrsb((int)tick(1u)) + __builtin_parity(tick(3u));
    printf("%d %d\n", s, calls);
    return 0;
}
