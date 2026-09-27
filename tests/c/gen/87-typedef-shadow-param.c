/* **形参名遮住外面同名的 typedef**（C11 6.2.1 第 4 段：形参的作用域是这个函数）。
 *
 * 逼出这一格的是 CPython：`Include/internal/pycore_asdl.h:14` 真的有
 * `typedef PyObject * string;`，而 `Objects/unicodeobject.c:2470` 的
 * `as_ucs4(PyObject *string, Py_UCS4 *target, …)` 正好拿 `string` 当形参名。
 * 不遮的话函数体里 `PyUnicode_KIND(string)` 展开出的 `((PyObject*)((string)))`
 * 会被读成**类型转换**（`(string)` 当成了类型名），报 `expression expected` ——
 * 那就是整份 `unicodeobject.c`（15436 行）长期卡在第 2476 行的真因。
 *
 * 局部变量那一路本来就对（`declareLocal` / `declareStaticLocal` / `declareExternLocal`
 * 三处都调了 `tdefShadow`），漏的只有**形参**这一路。
 *
 * 两种形状都要：`T x`（typedef 是非指针）与 `T *x`（typedef 本身是指针类型）——
 * 后者才是 CPython 那一格的样子，也是从前唯一红的那一种。 */
#include <stdio.h>

typedef int * string;
typedef int mytype;
typedef struct { int x; int y; } S;

/* `string` 当形参名：函数体里 `(string)` 是那个形参，不是类型 */
static int f1(int *string) { return *string + (int)((string) != 0); }

/* 非指针 typedef 当形参名 */
static int f2(int mytype) { return (mytype) + 1; }

/* struct typedef 当形参名（`S *S` —— 头文件里这种写法不少见） */
static int f3(S *S) { return (S)->x + S->y; }

/* 形参名遮住 typedef 之后，**函数体里仍能声明同名的局部量**（再遮一层） */
static int f4(int mytype) { { int mytype = 10; return mytype; } }

/* 形参那一层遮的只在这个函数里算：外面 `string` 照旧是类型 */
static string g(int *p) { return p; }

int main(void) {
    int v = 41;
    S s = { 3, 4 };
    printf("%d %d %d %d\n", f1(&v), f2(7), f3(&s), f4(1));
    printf("%d\n", *g(&v));
    return 0;
}
