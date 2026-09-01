/* 条件编译。`#if` 的算术在标准里只有 intmax_t，而「无符号性会传播」是唯一
   能被观测到的类型效应 —— 真实的头文件用它做特性判断。 */

#define ZERO 0
#define ONE 1
#define TEN 10

#if 1
int a1 = 1;
#endif
#if 0
int a2_never;
#endif

/* #else / #elif 的链，只有一支成立 */
#if 0
int b1_never;
#elif 0
int b2_never;
#elif 1
int b3 = 1;
#elif 1
int b4_never;
#else
int b5_never;
#endif

#if 0
int c1_never;
#else
int c2 = 1;
#endif

/* 嵌套：不成立的那一支里面的 #if 要整段跳过，连语法都不看 */
#if 0
#if 1
int d1_never;
#endif
this is not even valid C ~ @ `
#else
int d2 = 1;
#endif

/* #ifdef / #ifndef / defined */
#ifdef ONE
int e1 = 1;
#endif
#ifndef ONE
int e2_never;
#endif
#ifdef NOT_DEFINED
int e3_never;
#endif
#if defined ONE && defined(TEN) && !defined(NOT_DEFINED)
int e4 = 1;
#endif

/* 没定义的名字在 #if 里就是 0 */
#if NOT_DEFINED
int f1_never;
#endif
#if !NOT_DEFINED
int f2 = 1;
#endif

/* `defined` 后面的名字不许先展开 —— 这一格错了 defined 就永远是假的 */
#define ALIAS ONE
#if defined(ALIAS)
int f3 = 1;
#endif

/* 算术：优先级、括号、三目 */
#if TEN * 2 + 1 == 21 && (TEN - 1) % 3 == 0
int g1 = 1;
#endif
#if (1 ? 2 : 3) == 2 && (0 ? 2 : 3) == 3
int g2 = 1;
#endif
#if 1 << 4 == 16 && -8 >> 1 == -4
int g3 = 1;
#endif
#if (0xff & 0x0f) == 15 && (1 | 2) == 3 && (3 ^ 1) == 2 && ~0 == -1
int g4 = 1;
#endif

/* 无符号性传播：-1 转成无符号之后比 0u 大 */
#if -1 < 0
int h1 = 1;
#endif
#if -1 > 0u
int h2 = 1;
#endif
#if 0xffffffffffffffff == -1
int h3 = 1;
#endif
#if 2147483647 + 1 < 0
int h4 = 1;
#endif
#if 4294967295u / 2 == 2147483647
int h5 = 1;
#endif

/* 字符常量：值按 signed char 算 */
#if 'a' == 97 && 'A' == 65
int i1 = 1;
#endif
#if '\xff' < 0
int i2 = 1;
#endif
#if '\n' == 10 && '\0' == 0 && '\\' == 92 && '\'' == 39
int i3 = 1;
#endif
#if 'ab' == 24930
int i4 = 1;
#endif

/* 短路：右边不许因为除零而报错 */
#if 0 && (1 / 0)
int j1_never;
#endif
#if 1 || (1 / 0)
int j2 = 1;
#endif

/* 各种进制与后缀 */
#if 0x10 == 16 && 010 == 8 && 0b101 == 5
int k1 = 1;
#endif
#if 1u == 1 && 1l == 1 && 1ul == 1 && 1llu == 1 && 1LL == 1
int k2 = 1;
#endif

/* 宏在 #if 里先展开，函数式的也展开 */
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#if MAX(3, 7) == 7
int l1 = 1;
#endif

/* 展开成空的宏：整个 #if 就没有表达式了 —— 这是错的，所以这里给它一个 0 */
#define EMPTY_TO_ZERO 0
#if EMPTY_TO_ZERO
int m1_never;
#else
int m2 = 1;
#endif
