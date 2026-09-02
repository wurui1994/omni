/* 第八刀第五十四片：`__builtin_types_compatible_p`。
 *
 * 一个编译期的问句：两个**类型名**，相容就是 1。tcc 把两边最外层的 const/volatile
 * 抹掉再问 `is_compatible_types` —— 与赋值问的是同一句（`compareTypes`）。 */
#include <stdio.h>

#define C(a, b) printf("%-22s %-22s %d\n", #a, #b, __builtin_types_compatible_p(a, b));

typedef int myint;
typedef struct S { int x; } S;
enum E { A, B };
enum F { C1 };
struct T { int x; };
union U { int x; };

int main(void) {
  /* 整型：`signed` 写没写只对 char 有意义 */
  C(int, int) C(int, unsigned int) C(int, signed int) C(int, char)
  C(char, signed char) C(char, unsigned char) C(signed char, unsigned char)
  C(short, int) C(long, long long) C(long, int) C(float, double) C(void, void)
  C(unsigned long, unsigned long) C(_Bool, int)

  /* 限定符：最外层的不算，指向的东西上的算 */
  C(int, const int) C(int, volatile int) C(const volatile int, int)
  C(int *, const int *) C(const int *, const int *)

  /* 指针 */
  C(int *, int *) C(int *, void *) C(char *, unsigned char *) C(char *, signed char *)
  C(char **, void *) C(int **, int **)

  /* typedef 只是别名 */
  C(int, myint) C(myint *, int *) C(S, struct S)

  /* 枚举：两边都是枚举时比的是「同一个吗」 */
  C(enum E, enum E) C(enum E, enum F)

  /* struct/union：一个 tag 一个类型 */
  C(struct S, struct S) C(struct S, struct T) C(struct S, union U)

  /* 数组：长度要比，但有一边没写就算相容 */
  C(int[5], int[5]) C(int[5], int[10]) C(int[], int[10]) C(int[5], int *)
  C(int[2][3], int[2][3]) C(int[2][3], int[2][4])

  /* 函数：结构性地比；老式声明（`int()`）不说形参，所以只比返回类型 */
  C(int(int), int(int)) C(int(int), int(char)) C(int(), int(int)) C(int(), char(int))
  C(int(void), int(int)) C(int (*)(int), int (*)(int)) C(int(int, ...), int(int))
  return 0;
}
