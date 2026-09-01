/* 第六刀第二十片：`long double`。在这个目标上它**就是** double
 * （`tcc.h:237-241`：MACHO+ARM64 与 PE 都开 TCC_USING_DOUBLE_FOR_LDOUBLE），
 * 所以这一格钉的是「类型分开、表示相同」这件事：sizeof 是 8、算术与 printf 全按 double。
 * arm64 上凡是用 printf 的用例都必须先有它的声明，否则 tcc 自己会编错（变参 ABI）。 */
#include <stdio.h>

static long double gs = 2.5L;
static long double gd = 1.0 / 4;          /* 静态初始化式，除法在浮点里算 */
static long double gz[3] = { 1.5L, 2 };   /* 剩下那格按 C 归零 */

struct box { char c; long double d; };

static long double half(long double x) { return x / 2; }

int main(void) {
  long double a = 1.5L;
  long double b = a * 2;
  double d = b;              /* 往 double 走 */
  float f = (float)a;        /* 往 float 走（窄了） */
  long double c = d + f;     /* 常规算术转换：最宽的赢 */
  long long n = (long long)(b + 0.75L);
  long double back = (long double)n;
  struct box bx;

  bx.c = 'x';
  bx.d = a;

  printf("size %d %d %d %d\n",
         (int)sizeof(long double), (int)sizeof(a), (int)sizeof(gz), (int)sizeof(struct box));
  printf("val %Lf %Lf %Lf\n", a, b, c);
  printf("stat %.3Lf %Lg %Le\n", gs, gd, gz[0]);
  printf("zero %Lf %Lf\n", gz[1], gz[2]);
  printf("conv %lld %Lf %Lf\n", n, back, half(a));
  printf("box %c %Lf\n", bx.c, bx.d);
  printf("cmp %d %d %d\n", (int)(a > 1.0L), (int)(a == 1.5), (int)(f < b));
  return (int)n + (int)gs;
}
