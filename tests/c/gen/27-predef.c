/* 第八刀第一片：预定义的宏拿来写真代码。
 *
 * 这一份与 cpp/07-predef.c 不同：那边量的是「展开成什么」，这边量的是
 * 「拿它们声明的类型、开的分支，编出来跑起来对不对」。 */

#include <stdio.h>

/* 标准类型的底子：用它们声明，而不是硬写 unsigned long */
typedef __SIZE_TYPE__ my_size_t;
typedef __PTRDIFF_TYPE__ my_ptrdiff_t;
typedef __INT64_TYPE__ my_i64;
typedef __INT32_TYPE__ my_i32;
typedef __UINTPTR_TYPE__ my_uintptr;
typedef __WCHAR_TYPE__ my_wchar;

/* nullability 标注会被抹掉，所以这是一条普通的声明 */
static int * _Nonnull firstOf(int * _Nonnull a) { return a; }

/* __has_builtin 一律回 0 -> 走「编译器什么都没有」那一支 */
#if __has_builtin(__builtin_expect)
#define LIKELY(x) __builtin_expect(!!(x), 1)
#else
#define LIKELY(x) (x)
#endif

int main(void) {
  int arr[3];
  arr[0] = 11;
  arr[1] = 22;
  arr[2] = 33;

  printf("sizes %d %d %d %d %d %d\n",
    (int)sizeof(my_size_t), (int)sizeof(my_ptrdiff_t), (int)sizeof(my_i64),
    (int)sizeof(my_i32), (int)sizeof(my_uintptr), (int)sizeof(my_wchar));

  /* 宏里的数值直接当常量表达式用 */
  printf("model %d %d %d %d\n",
    __SIZEOF_POINTER__, __SIZEOF_LONG__, __SIZEOF_INT__, __CHAR_BIT__);
  printf("max %d %lld %d\n", __INT_MAX__, __LONG_LONG_MAX__, (int)(__LONG_MAX__ >> 32));
  printf("std %ld %d\n", (long)__STDC_VERSION__, __TINYC__);

  /* my_size_t 真的是无符号的：-1 变成一个大数 */
  my_size_t n = (my_size_t)-1;
  printf("unsigned %d\n", n > 0);
  my_ptrdiff_t d = (my_ptrdiff_t)-1;
  printf("signed %d\n", d < 0);

  /* uintptr 装得下一个指针 */
  my_uintptr p = (my_uintptr)&arr[0];
  printf("roundtrip %d\n", *(int *)p);
  printf("nonnull %d\n", *firstOf(arr));
  printf("likely %d\n", LIKELY(arr[1] == 22));

#if defined(__aarch64__) || defined(__x86_64__)
  printf("cpu known\n");
#else
  printf("cpu unknown\n");
#endif

#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
  {
    unsigned x = 0x11223344u;
    unsigned char *b = (unsigned char *)&x;
    printf("le %d %d\n", b[0], b[3]);
  }
#endif

  return (int)sizeof(my_size_t) + __SIZEOF_INT__ + arr[2];
}
