/* 第八刀第二片：自带的那几份头文件。
 *
 * `#include <stddef.h>` 一族从内建的系统头目录来（`src/include/`），
 * tcc 那边用它自己 `include/` 里的同名文件 —— 两份文本不同，**行为必须一样**，
 * 所以这一份的 oracle 还是 `tcc -run` 的退出码加 stdout 逐字节。 */

#include <stddef.h>
#include <stdarg.h>
#include <stdbool.h>
#include <float.h>
#include <stdio.h>

struct pt { char tag; int x; double y; char name[4]; };

/* stddef.h：size_t / ptrdiff_t 是真的类型，不是 int */
static size_t countTo(size_t n) {
  size_t s = 0;
  size_t i;
  for (i = 0; i < n; i++) s += i;
  return s;
}

/* stdarg.h：标准的名字接到内建上 */
static int sum(int n, ...) {
  va_list ap;
  int s = 0;
  int i;
  va_start(ap, n);
  for (i = 0; i < n; i++) s += va_arg(ap, int);
  va_end(ap);
  return s;
}

static int relay(int n, va_list ap) {
  va_list copy;
  int s = 0;
  int i;
  va_copy(copy, ap);
  for (i = 0; i < n; i++) s += va_arg(copy, int);
  va_end(copy);
  return s;
}

static int outer(int n, ...) {
  va_list ap;
  int s;
  va_start(ap, n);
  s = relay(n, ap);
  va_end(ap);
  return s;
}

/* stdbool.h：bool 就是 _Bool，赋值时收成 0/1 */
static bool isEven(int x) { return x % 2 == 0; }

int main(void) {
  /* ---- stddef.h */
  printf("size %d %d %d\n",
    (int)sizeof(size_t), (int)sizeof(ptrdiff_t), (int)sizeof(wchar_t));
  printf("null %d\n", (void *)0 == NULL);
  printf("count %d\n", (int)countTo(10));
  printf("offset %d %d %d %d\n",
    (int)offsetof(struct pt, tag), (int)offsetof(struct pt, x),
    (int)offsetof(struct pt, y), (int)offsetof(struct pt, name));

  /* size_t 是无符号的：倒着数会绕，不会变负 */
  {
    size_t z = 0;
    printf("wrap %d\n", (int)(z - 1 > z));
    ptrdiff_t d = (ptrdiff_t)0 - 1;
    printf("signed %d\n", (int)(d < 0));
  }

  /* ---- stdarg.h */
  printf("va %d %d %d\n", sum(0), sum(3, 1, 2, 3), sum(5, 10, 20, 30, 40, 50));
  printf("relay %d\n", outer(4, 1, 2, 3, 4));

  /* ---- stdbool.h */
  {
    bool t = true;
    bool f = false;
    bool big = (bool)7;
    printf("bool %d %d %d %d %d\n", t, f, big, isEven(4), isEven(5));
    printf("boolsize %d\n", (int)sizeof(bool));
#ifdef __bool_true_false_are_defined
    printf("boolmacro yes\n");
#endif
  }

  /* ---- float.h：形状与关系，而不是十进制的字面量 */
  printf("mant %d %d\n", FLT_MANT_DIG, DBL_MANT_DIG);
  printf("dig %d %d %d\n", FLT_DIG, DBL_DIG, DECIMAL_DIG);
  printf("exp %d %d %d %d\n", FLT_MIN_EXP, FLT_MAX_EXP, DBL_MIN_EXP, DBL_MAX_EXP);
  printf("radix %d %d\n", FLT_RADIX, FLT_ROUNDS);
  printf("eps %d %d\n", 1.0 + DBL_EPSILON > 1.0, 1.0 + DBL_EPSILON / 2.0 == 1.0);
  printf("range %d %d\n", DBL_MAX > 1e307, DBL_MIN < 1e-307);
  /* tcc 的 float.h 按 binary128 写 LDBL_*，而这个目标上 long double 就是 double ——
   * 于是 MAX 溢出成 inf、MIN 下溢成 0，而 MANT_DIG 说 113。这三条钉住那处矛盾
   * （见 src/include/float.h 头上那一节）。 */
  printf("ldbl %d %d %d %d\n",
    LDBL_MANT_DIG, (int)sizeof(long double),
    LDBL_MAX > DBL_MAX, LDBL_MIN == 0.0);

  return (int)sizeof(size_t) + sum(3, 1, 2, 3) + DBL_MANT_DIG;
}
