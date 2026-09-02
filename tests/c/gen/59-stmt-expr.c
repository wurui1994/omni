/* 第八刀第三十八片：GNU 的语句表达式 `({ …; x; })`。
 * 值是最后那条直接长在里面的表达式语句的值；一条都没有就是 void。 */
#include <stdio.h>

int calls;

int f(int x) { calls++; return x; }

#define MAX(a, b) ({ int _a = (a), _b = (b); _a > _b ? _a : _b; })

int main(void)
{
    int a = 3;
    double d;
    int arr[4];
    int i;

    printf("simple=%d\n", ({ 42; }));
    printf("decl=%d\n", ({ int x = 5; x * 2; }));
    printf("seq=%d\n", ({ 1; 2; 3; }));
    /* 里面有循环 */
    printf("loop=%d\n", ({ int s = 0; for (i = 0; i < 4; i++) s += i; s; }));
    /* 宏里用它：两个实参各求值一次 */
    calls = 0;
    printf("max=%d calls=%d\n", MAX(f(3), f(7)), calls);
    /* void 的那一种：整条当语句用 */
    ({ a = a + 1; });
    printf("a=%d\n", a);
    /* 嵌套 */
    printf("nest=%d\n", ({ int y = ({ 4; }) + 1; y; }));
    /* 浮点与指针 */
    d = ({ 1.5 + 1.0; });
    printf("d=%g\n", d);
    printf("p=%s\n", ({ char *p = "hi"; p; }));
    /* 在 sizeof 里：不求值 */
    calls = 0;
    printf("so=%d calls=%d\n", (int)sizeof( ({ do { } while (0); f(1); }) ), calls);
    /* 结构体也能当值 */
    for (i = 0; i < 4; i++) arr[i] = i * i;
    printf("arr=%d\n", ({ arr[2]; }));
    /* 带 if/else 的那一条不留值，最后那条表达式才留 */
    printf("ifel=%d\n", ({ if (a > 0) a = a; else a = 0; a + 100; }));
    return 0;
}
