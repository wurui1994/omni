/* **字面量裹着圆括号铺进 char 数组**（`char d[8] = ("abc")`）—— gcc/clang 的扩展。
 *
 * C11 6.7.9 第 14 段只说了「字符串字面量，可以外加一对**花括号**」。圆括号是 GNU 的
 * 宽松处，`tcc` 不收（`'{' expected (got ';')`）—— 所以这一格的尺子是 clang 而不是 tcc，
 * 也就是这一组（`gnu/`）存在的理由。
 *
 * 逼出它的是 CPython：`Include/internal/pycore_runtime_init.h` 那一族静态初始化式里
 * 宏参数外面带着括号，展开成 `._data = ("<dictcomp>")`。`Python/pystate.c:309` 与
 * `Python/pylifecycle.c:123` 两份**整份**文件卡在它上头 —— 借 CPython 的运行时要这一格。
 *
 * 四种位置都考：顶层、指定初始化符、按位置、嵌一层；再加一格"括号后面还接着东西"
 * （`("ab")[1]`）—— 那**不是**铺数组，是一个整型常量表达式，两条路不能混。 */
#include <stdio.h>

static char g1[6] = ("hi");
static char g2[] = ("abc");

struct S {
    int len;
    char d[12];
    char e[4];
};
static struct S s1 = { .len = 3, .d = ("abc"), .e = ("xy") };
static struct S s2 = { 7, ("by-position"), ("ab") };

struct Outer { struct S in; int tail; };
static struct Outer o1 = { .in = { .len = 1, .d = ("nested") }, .tail = 9 };

/* 括号裹着、后面还接着下标：这**不是**铺数组，是一次普通的下标（静态初始化式里
 * 我们还没有这一格 —— 那要在 data 段里读一条串常量的字节，记在 `tryParenStr` 旁边），
 * 所以这一格放在函数体里考。`sizeof(("abcd"))` 照旧是 5。 */
static int n1 = sizeof(("abcd"));

int main(void) {
    char c1 = ("ab")[1];
    printf("%s %s %d %d\n", g1, g2, (int)sizeof(g1), (int)sizeof(g2));
    printf("%d %s %s\n", s1.len, s1.d, s1.e);
    printf("%d %s %s\n", s2.len, s2.d, s2.e);
    printf("%d %s %d\n", o1.in.len, o1.in.d, o1.tail);
    printf("%c %d\n", c1, n1);
    return 0;
}
