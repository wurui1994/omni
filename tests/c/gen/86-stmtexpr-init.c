/* 语句表达式当**声明的初值**，而声明的类型是结构体 / 数组。
 *
 * 卡住的是**语法**那一格：`initializer` 见了 `(` 且类型是聚合，就去问"这是不是复合
 * 字面量 `(T){…}`"—— 而 `__extension__` 在我们这儿是个类型起始记号，于是拐进
 * `typeName()`，撞在 `{` 上报 `')' expected`。标量那一档从来没撞上（那道闸只放聚合进来）。
 *
 * 量出来的：`omni.h` 的 `OMNI__AGET` 展开成 `(__extension__({ … }))`，值是 `omni_str`
 * 这个结构体 —— go 的 `for _, c := range []string{…}` 编原生时就撞在这儿。 */
#include <stdio.h>

typedef struct { int a; double b; } P;

#define GET(p, i) (__extension__({ P *q_ = (p); int j_ = (i); q_[j_]; }))
#define ARR(p) (__extension__({ int (*r_)[3] = (p); *r_; }))

int main(void)
{
    P ps[2];
    int xs[3];
    ps[0].a = 7; ps[0].b = 1.5;
    ps[1].a = 9; ps[1].b = 2.5;
    xs[0] = 4; xs[1] = 5; xs[2] = 6;

    /* 结构体：语句表达式当初值 */
    P s = GET(ps, 1);
    printf("s %d %g\n", s.a, s.b);

    /* 带 __extension__ 的那一种也要在**实参**位置上照旧好使 */
    printf("arg %d\n", GET(ps, 0).a);

    /* 数组类型的语句表达式（值是数组、按结构体那条路拷） */
    struct { int v[3]; } w;
    w.v[0] = xs[0]; w.v[1] = xs[1]; w.v[2] = xs[2];
    printf("w %d %d\n", w.v[0], w.v[2]);

    /* 复合字面量那一路不能被破坏：`(T){…}` 照旧是"直接写那对花括号" */
    P c = (P){11, 3.5};
    printf("c %d %g\n", c.a, c.b);

    /* 括号裹一个同类型的值也照旧 */
    P d = (c);
    printf("d %d %g\n", d.a, d.b);

    /* 标量那一档（从前就好使，别回退） */
    int n = (__extension__({ int t_ = 3; t_ + 4; }));
    printf("n %d\n", n);
    return 0;
}
