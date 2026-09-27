/* **静态初始化式里的 `常量 ? a : b`** —— 两支是地址常量的那一种。
 *
 * 我们的三目落成「IF + 两个槽 + STORE/LOAD」（见 `exprCond`），而静态初始化式要的是一个
 * 编译期的数或一条重定位 —— 把那串指令**反着读**是读不出分支的，于是从前报
 * `initializer element is not constant`。修法：条件折得出来（`kfoldOf`，这一刀顺带让它认
 * 十条比较）就**只发被选中那一支**，另一支的记号纯词法跳掉（`skipCondArm`）。
 * C 本来就说没走到的那一支不求值，所以这不是"优化"，是让这一格算得出来。
 *
 * 逼出它的是 CPython 的 `_Py_LATIN1_CHR(CH)`（`Include/internal/pycore_global_strings.h:936`）：
 *
 *     ((CH) < 128 ? (PyObject*)&_Py_SINGLETON(strings).ascii[(CH)]
 *                 : (PyObject*)&_Py_SINGLETON(strings).latin1[(CH) - 128])
 *
 * Argument Clinic 生成的 `_kwtuple` 里到处是它（量到 75 处、8 份 `clinic/*.h`），
 * 于是 `Modules/itertoolsmodule.c` 一族整份编不出。这一刀之后它与
 * `Modules/_collectionsmodule.c` 都干净出 `.o`。 */
#include <stdio.h>

int ascii_tab[128];
int latin1_tab[128];

#define CHR(ch) ((ch) < 128 ? &ascii_tab[(ch)] : &latin1_tab[(ch) - 128])

/* 四种：真支、假支、边界上的两格（127 / 128） */
static int *a1 = CHR('n');
static int *a2 = CHR(200);
static int *a3 = CHR(127);
static int *a4 = CHR(128);
/* 嵌一层（里层的 `? :` 自己配对 —— `skipCondArm` 那个 `q` 计数） */
static int *a5 = 1 ? (0 ? &ascii_tab[1] : &ascii_tab[2]) : &latin1_tab[3];
/* 串常量两支 */
static const char *s1 = 1 ? "yes" : "no";
static const char *s2 = 0 ? "yes" : "no";
/* 在指定初始化符里，且与别的成员混着 */
struct T { int *p; const char *s; long n; };
static struct T t1 = { .p = CHR('a'), .s = (1 > 2) ? "x" : "y", .n = 7 };
/* GNU 的 `x ? : y`（第一支省掉）—— 条件是常量，只求值一次 */
static int *a6 = (1 ? : 0) ? &ascii_tab[5] : &latin1_tab[5];

int main(void) {
    printf("%d %d %d %d\n", (int)(a1 - ascii_tab), (int)(a2 - latin1_tab),
           (int)(a3 - ascii_tab), (int)(a4 - latin1_tab));
    printf("%d %s %s\n", (int)(a5 - ascii_tab), s1, s2);
    printf("%d %s %ld %d\n", (int)(t1.p - ascii_tab), t1.s, t1.n, (int)(a6 - ascii_tab));
    return 0;
}
