/* 第八刀第二十七片：K&R 的函数定义 —— 形参表里只有名字，类型摆在 `{` 之前。
 *
 * tinycc 自己那份 `tests/tcctest.c` 里有一整段这种写法（`#if __TINYC__`），
 * 而我们的前端读到 339 行就停了。三件事一起：省掉的 `int`（`f() {…}`）、
 * 标识符表（`op(a, b)`）、以及形参声明串（`old_style_f(a,b,c) int a, b; double c;`）。 */
#include <stdio.h>

/* 省掉返回类型：默认 int */
f() { return 3; }

/* 标识符表，没有声明串：形参就是 int */
int op(a, b) { return a / b; }

/* 有声明串，一行一个 */
int kr2(a, b) int a; int b; { return a * b; }

/* 一行声明两个，再加一个 double —— 声明的次序与形参的次序无关 */
void old_style_f(a, b, c) double c; int a, b; {
  printf("old_style_f: a=%d b=%d c=%f\n", a, b, c);
}

/* 老式形参里的 float 是 double：调用方按「实参提升」传的就是 double */
void takes_float(x) float x; { printf("takes_float: %.3f\n", x); }

/* 形参是函数类型 -> 退化成函数指针（与原型里那条规则同一个） */
void takes_fn(cmpfn) int cmpfn(); {
  printf("takes_fn: null=%d\n", cmpfn == 0);
}

/* 形参是数组 -> 退化成指针 */
int sum3(v) int v[]; { return v[0] + v[1] + v[2]; }

/* 指针形参 */
void takes_ptr(p) char *p; { printf("takes_ptr: %s\n", p); }

/* 多给的实参：没有原型可核对，被调方不看（tcc 也不报错） */
int sum2(a, b) { return a + b; }

int main(void) {
  int v[3] = { 4, 5, 6 };
  printf("f=%d op=%d kr2=%d\n", f(), op(9, 2), kr2(3, 4));
  old_style_f(1, 2, 3.5);
  takes_float(2.25);
  takes_fn(0);
  printf("sum3=%d\n", sum3(v));
  takes_ptr("hello");
  printf("sum2=%d %d\n", sum2(1, 2), sum2(1, 2, 99));
  return op(20, 4) + kr2(2, 3);
}
