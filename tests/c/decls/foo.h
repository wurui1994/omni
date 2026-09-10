/*
 * `c.declsOf` 的用例（ADR-0022 的 J4d 第二条路：`import "libfoo.dylib" with "foo.h"`）。
 *
 * 两半都要：**收得下的**（落进 C_ABI 那七个词）与**收不下的**（落不进，要带一句为什么）。
 * 后一半才是这一条真正防的东西 —— 一个真头文件里总有几条落不进去，而其中一条都不该让
 * 整次 import 失败，也不该被悄悄放宽成一个错的 ABI。
 */

/* ---- 收得下 ---- */
int foo_add(int a, int b);
double foo_scale(double x, long n);
long foo_len(const char *s);
void foo_hi(void);
_Bool foo_ok(void *p);
int foo_printf(const char *fmt, ...);
/* 函数指针形参就是一个地址，所以是 ptr —— 这一条是**收得下**的 */
int foo_cb(int (*f)(int));
/* 数组形参在 C 里退化成指针 */
int foo_sum(int a[], int n);
/* 枚举是整数 */
enum Color { RED, GREEN };
int foo_paint(enum Color c);

/* ---- 收不下 ---- */
/* float / long double：不许悄悄放宽成 f64 —— 那是错的调用约定 */
float foo_f(float x);
long double foo_ld(long double x);
/* struct 按值：要 ABI 的实参分类，那是 ADR-0014 决策 4 刻意避开的坑 */
struct P { int x; int y; };
int foo_area(struct P p);
struct P foo_mk(int x, int y);
/* 老式声明：`f()` 不是 `f(void)` —— 形参表没说，调用点给几个都合法 */
int foo_old();

/* ---- 常量那一半 ----
 * 宏与枚举常量：用 `with "h"` 的正当理由（`GL_COLOR_BUFFER_BIT` 在 C 里是 `#define`，
 * 头文件是那个名字的唯一出处；没有这一格，一个 OpenGL 程序只能把 16384 抄进源码）。
 * 收得下的是"体求得出一个值"的那些，别的一样带一句为什么。 */
#define FOO_ONE 1
#define FOO_HEX 0x4000
#define FOO_SHIFT (1 << 3)
#define FOO_NEG -1
#define FOO_OCT 0755
#define FOO_CHR 'A'
#define FOO_PI 3.5
#define FOO_EXP 1.5e3
#define FOO_SUM (FOO_ONE + FOO_SHIFT)
#define FOO_COND (FOO_ONE ? 10 : 20)
#define FOO_ENUM GREEN
#define FOO_NAME "omni"
/* 求不出值的：一段代码、一个类型、一个空的守卫、一个不知道的名字 */
#define FOO_CALL foo_add(1, 2)
#define FOO_GUARD
#define FOO_UNKNOWN NOT_A_CONSTANT
