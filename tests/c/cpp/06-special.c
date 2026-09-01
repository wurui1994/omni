/* 特殊宏与剩下的指令。`__DATE__`/`__TIME__` 不在这里 —— 它们的值随时钟走，
   进不了逐字节比对的轴（见 cpp-bad/date.c 那条声明出来的边界）。 */

int l1 = __LINE__;
int l2 =
  __LINE__;
#define LINE_NOW __LINE__
int l3 = LINE_NOW;
#define WHERE(x) x, __LINE__
int l4[] = { WHERE(1) };

char *f1 = __FILE__;
#define FILE_NOW __FILE__
char *f2 = FILE_NOW;

/* __COUNTER__ 每次取都加一 */
int c1 = __COUNTER__;
int c2 = __COUNTER__;
#define UNIQ(p) p##__COUNTER__
int c3 = __COUNTER__;

/* defined 对这几个也成立（tcc 给它们放了占位定义） */
#if defined(__LINE__) && defined(__FILE__) && defined(__COUNTER__)
int d1 = 1;
#endif

/* #line 换行号，__LINE__ 跟着走 */
#line 100
int n1 = __LINE__;
#line 200 "renamed.c"
int n2 = __LINE__;
char *n3 = __FILE__;

/* 空指令行是合法的 */
#
#   
int e1 = 1;

/* 未知的 pragma 原样印回输出 —— 它是给下一道工序看的 */
#pragma pack(1)
int p1 = 1;
#pragma GCC diagnostic ignored "-Wall"
int p2 = 2;

/* push_macro / pop_macro 认，而且不印回去 */
#define M 1
int q1 = M;
#pragma push_macro("M")
#undef M
#define M 2
int q2 = M;
#pragma pop_macro("M")
int q3 = M;

/* #pragma once 在主文件上也合法（无害） */
#pragma once
int r1 = 1;
