/* **`typeof(__extension__ ({ … }))`** —— 嵌套的语句表达式宏。
 *
 * `__extension__` 在我们这儿是个类型起始记号（声明说明符里真有它），所以每一处
 * 「这是类型名还是表达式」的分岔口都得先把它吃掉。`unary()` 与它括号那一格早就吃了
 * （`gen/73`、`gen/86`），漏的是 `typeof(…)` 里头那一个。
 *
 * 逼出这一格的是 CPython 的 `Py_MIN`/`Py_MAX`（`Include/pymacro.h:119`）：
 *
 *     #define Py_MIN(x, y) __extension__ \
 *         ({ _Py_TYPEOF (x) _x = (x); _Py_TYPEOF (y) _y = (y); _x < _y ? _x : _y; })
 *
 * 单层用它没事；**嵌一层**（`Py_MIN(len, Py_MAX(a, b))`）里层那一整块就正好落在外层的
 * `_Py_TYPEOF(...)` 括号里，于是报 `')' expected (got '{')`。
 * `Objects/unicode_formatter.c:197` 就是这么一行 —— 那一份文件从前整份编不出。 */
#include <stdio.h>

#define MIN(x, y) __extension__ \
    ({ __typeof__ (x) _x = (x); __typeof__ (y) _y = (y); _x < _y ? _x : _y; })
#define MAX(x, y) __extension__ \
    ({ __typeof__ (x) _x = (x); __typeof__ (y) _y = (y); _x > _y ? _x : _y; })

/* `typeof` 里除了语句表达式，别的形状照旧要对：类型名、普通表达式、连写两个
 * `__extension__`（那条 `while` 的意思）。
 *
 * 注意**别**写 `typeof(__extension__ int)`：tcc 收，clang 明着拒
 * （`error: expected expression`）—— 那个词在 GNU 那边只许在表达式前面。
 * 这份用例的 oracle 是 tcc，但两边都能编才说明考的是这一格而不是某家的宽松。 */
typedef __typeof__(int) t_int;
typedef __typeof__(__extension__ __extension__ 1L) t_long;

int main(void) {
    int a = 3, b = 5, remaining = 2, min_width = 7;
    /* 一层 */
    printf("%d %d\n", MIN(a, b), MAX(a, b));
    /* 两层 —— 从前红在这儿 */
    printf("%d\n", MIN(b, MAX(MAX(remaining, min_width), 1)));
    /* 三层，且里层用的是别的类型（long）—— typeof 真的把类型带出来了 */
    long la = 9;
    printf("%ld\n", MAX(la, (long)MIN(a, MIN(b, 1))));
    /* `sizeof` 那一路（它走 unary，本来就对）与 typeof 那一路给的是同一个类型 */
    printf("%d %d %d\n", (int)sizeof(MIN(la, la)), (int)sizeof(t_int), (int)sizeof(t_long));
    /* 算出来的值与没有语句表达式的写法一致 */
    printf("%d\n", MIN(a, b) == (a < b ? a : b));
    return 0;
}
