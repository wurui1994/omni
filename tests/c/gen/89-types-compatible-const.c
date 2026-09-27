/* **`__builtin_types_compatible_p` 与 `((void)x, c)` 在「必须是常量」的位置上**。
 *
 * 那一问本来就有（`gen/74-types-compatible.c` 考的是表达式那一路），可我们的常量
 * 表达式是**另一台**机器（只认记号、不建值），它从前不认这一格 —— 于是数组维度里
 * 写它就报 `constant expression expected`。
 *
 * 逼出这一格的是 CPython 的 `Py_ARRAY_LENGTH`（`Include/pymacro.h:205`）：我们的
 * `__GNUC__` 是 4，于是走 GCC 扩展那一支，长度算式里明着带着这一问与一句
 * `Py_BUILD_ASSERT_EXPR`（`pymacro.h:167`，形状是 `((void)sizeof(struct{…}), 0)`）。
 * `Objects/typeobject.c:11720` 的 `slotdefs_dups[Py_ARRAY_LENGTH(slotdefs)][…]`
 * 就是它 —— 13007 行卡在这一行上。
 *
 * 一共三格：常量里的那一问、`(void)` 强制转换（把值丢掉）、括号里的逗号。 */
#include <stdio.h>

static int a[7];
static long la[3];

/* 一、数组维度里的那一问 */
static char d1[__builtin_types_compatible_p(int, int) ? 3 : 9];
static char d2[__builtin_types_compatible_p(int, long) ? 9 : 4];
/* `typeof` 两边：数组与「首元素的地址」不相容，正是 Py_ARRAY_LENGTH 要的那句断言 */
static char d3[__builtin_types_compatible_p(__typeof__(a), __typeof__(&a[0])) ? 9 : 5];
/* const/volatile 在最外层不算（与赋值同一句话） */
static char d4[__builtin_types_compatible_p(const int, int) ? 6 : 9];

/* 二、`(void)` 与括号里的逗号 */
static char d5[((void)sizeof(int), 7)];
static char d6[((void)0, (void)1, 8)];
/* 三、`_Static_assert` 藏在类型里 —— Py_BUILD_ASSERT_EXPR 的原样形状 */
#define BUILD_ASSERT_EXPR(cond) \
    ((void)sizeof(struct { int dummy; _Static_assert(cond, #cond); }), 0)
#define ARRAY_LENGTH(array) \
    (sizeof(array) / sizeof((array)[0]) \
     + BUILD_ASSERT_EXPR(!__builtin_types_compatible_p(__typeof__(array), \
                                                       __typeof__(&(array)[0]))))
static char dups[ARRAY_LENGTH(a)][1 + ARRAY_LENGTH(la)];

/* 四、别的「必须是常量」的位置：静态初始化式、`_Static_assert`、位域宽度、case 标签 */
static int si = __builtin_types_compatible_p(char *, char *) + ((void)9, 10);
_Static_assert(__builtin_types_compatible_p(unsigned, unsigned int), "same");
_Static_assert(ARRAY_LENGTH(a) == 7, "len");
struct bf { unsigned f : __builtin_types_compatible_p(short, short) ? 3 : 9; };

static int pick(int x) {
    switch (x) {
    case __builtin_types_compatible_p(double, double) ? 1 : 2: return 100;
    case ((void)0, 5): return 200;
    default: return 300;
    }
}

int main(void) {
    printf("%d %d %d %d %d %d\n", (int)sizeof(d1), (int)sizeof(d2), (int)sizeof(d3),
           (int)sizeof(d4), (int)sizeof(d5), (int)sizeof(d6));
    printf("%d %d %d\n", (int)sizeof(dups), (int)sizeof(dups[0]), (int)ARRAY_LENGTH(la));
    printf("%d %d %d %d\n", si, pick(1), pick(5), pick(9));
    struct bf b = { 5 };
    printf("%u %d\n", b.f, a[0]);
    return 0;
}
