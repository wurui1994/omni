/* 第六刀第十三片：函数指针（MIR 加了 `CALLI`）。
 *
 * 函数指针的**值**是「函数表下标 + 1」（0 留给空指针），编码定在 ir.js 的 `CALLI` 上。
 * 前端只需要一条纪律：函数指示符是一个**函数类型的内存左值**，「地址」就是那个值 ——
 * 于是 `f`、`&f`、`*f`、`f(x)`、`(*fp)(x)`、`fp(x)` 六种写法走同一条路。
 *
 * printf 一定要先有声明：arm64 的变参走栈，没声明时 **tcc 自己**会编错。 */

#include <stdio.h>

static int twice(int x) { return x * 2; }
static int thrice(int x) { return x * 3; }
static int neg(int x) { return -x; }
static int add(int a, int b) { return a + b; }
static void bump(int *p) { *p += 1; }

/* 静态的函数指针表 —— tinycc 自己的源码里到处是这种表。函数名是**地址常量**
 * （C11 6.6 第 9 段），所以它能当静态初始化式。 */
static int (*g)(int) = twice;
static int (*tab[3])(int) = { twice, thrice, neg };

struct Op {
  const char *name;
  int (*fn)(int, int);
};

/* 回调：形参是函数指针 */
static int apply(int (*fn)(int), int x) { return fn(x); }

/* 形参写成函数类型也一样（C11 6.7.6.3 第 8 段：它就是函数指针） */
static int apply2(int fn(int), int x) { return fn(x); }

/* 回一个函数指针 */
static int (*chooser(int i))(int) { return tab[i]; }

int main(void) {
  int (*fp)(int) = twice;
  int (*fps[2])(int);
  struct Op ops[2];
  int s = 0;
  int i;
  int n = 5;

  /* 六种写法，同一个函数 */
  s += fp(1) + (*fp)(1) + (**fp)(1);            /* 2 + 2 + 2 */
  fp = &thrice;                                  /* `&f` 与 `f` 是同一个东西 */
  s += fp(1) + apply(fp, 2) + apply2(thrice, 3); /* 3 + 6 + 9 */

  /* 比较：与函数名比、与 0 比 */
  s += (fp == thrice) + (fp != twice) + (fp != 0) + (g == twice);  /* 4 */

  s += g(10) + tab[0](1) + tab[1](1) + tab[2](1);  /* 20 + 2 + 3 - 1 */

  fps[0] = tab[1];
  fps[1] = neg;
  for (i = 0; i < 2; i++) s += fps[i](7);        /* 21 - 7 */

  /* struct 成员上的函数指针 */
  ops[0].name = "add";
  ops[0].fn = add;
  ops[1].name = "add2";
  ops[1].fn = add;
  s += ops[0].fn(3, 4) + ops[1].fn(5, 6);        /* 7 + 11 */

  /* 回来的函数指针立刻调用 */
  s += chooser(1)(2) + (*chooser(2))(3);         /* 6 - 3 */

  /* void 的与收指针的 */
  {
    void (*vp)(int *) = bump;
    vp(&n);
    vp(&n);
    s += n;                                      /* 7 */
  }

  printf("%s=%d %s=%d chooser=%d\n",
    ops[0].name, ops[0].fn(1, 2), ops[1].name, ops[1].fn(3, 4), chooser(0)(21));
  printf("s=%d\n", s);
  return s & 255;
}
