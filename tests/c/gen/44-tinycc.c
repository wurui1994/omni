/* 第八刀第二十片：编完 tinycc 自己那一整份源码时撞上的那几格。
 *
 * 每一格都是先在 `tcc.c`（`-DONE_SOURCE=1 -DTCC_TARGET_ARM64`，于是 tccpp.c、
 * tccgen.c、tccdbg.c、tccasm.c、tccelf.c、tccrun.c、arm64-* 全在里面）上撞到、
 * 再回头补的：
 *   `__func__` / `__FUNCTION__`   —— tccgen.c 的 `tcc_error` 一路
 *   常量表达式里的 `sizeof 表达式` —— tccdbg.c 的 `N_DEFAULT_DEBUG`
 *   `sizeof ((T*)0)->字段`        —— tccdbg.c:497
 *   `offsetof`（转换的常量折叠）   —— libtcc.c 的 `options_W` / `options_f` 那几张表
 *   `inline` 的体等被引用才发      —— macOS <math.h> 的 `__sincosf`
 *   `__builtin_expect`            —— tcc.c 的 `PROBE_INLINE` 一带
 */
#include <stdio.h>
#include <stddef.h>

/* ---- `__func__` 的三种拼法。`__PRETTY_FUNCTION__` 不是记号，是 tccdefs.h 里
 * 一条 `#define __PRETTY_FUNCTION__ __FUNCTION__`。 */
static const char *who(void) { return __func__; }
static const char *who2(void) { return __FUNCTION__; }
static const char *who3(void) { return __PRETTY_FUNCTION__; }

/* ---- 常量表达式里的 `sizeof 表达式`：这张表的**长度**由表自己算出来 */
static const struct {
  int type;
  int size;
  const char *name;
} tab[] = {
  { 1, 4, "int" },
  { 2, 1, "char" },
  { 3, 8, "long long" },
  { 4, 2, "short" },
};
#define N_TAB (sizeof(tab) / sizeof(tab[0]))
static int used[N_TAB];

/* ---- `offsetof`：展开成 `((unsigned long)&((T*)0)->f)`，要靠转换的常量折叠 */
typedef struct {
  short a;
  char b;
  long long c;
  const char *d;
} Rec;

typedef struct { unsigned short off; const char *name; } FieldDef;
static const FieldDef fields[] = {
  { offsetof(Rec, a), "a" },
  { offsetof(Rec, b), "b" },
  { offsetof(Rec, c), "c" },
  { offsetof(Rec, d), "d" },
  { 0, NULL },
};

/* ---- `sizeof ((T*)0)->字段`：里层那个 `(` 是真的强制转换，外层那个才是
 * 「可能的类型名」。数在编译期就出来了，所以能当数组维度用。 */
static char nvalue[sizeof ((Rec *)0)->c];

/* ---- inline：`grow` 一次都没被引用，它的体里那个 `no_such_abi` 于是
 * 连读都不该读（真读了就会撞上「外部函数返回 struct 还没到」）。 */
struct Pair { double x, y; };
struct Pair no_such_abi(double t);
static inline void grow(double t, double *px, double *py) {
  struct Pair p = no_such_abi(t);
  *px = p.x;
  *py = p.y;
}
static inline int twice(int x) { return x + x; }
static inline int quad(int x) { return twice(twice(x)); }   /* inline 调 inline */

int main(void) {
  printf("%s %s %s\n", who(), who2(), who3());
  printf("%s|%d\n", __func__, (int)sizeof(__func__));

  printf("%d %d\n", (int)N_TAB, (int)(sizeof(used) / sizeof(used[0])));
  int sum = 0;
  for (int i = 0; i < (int)N_TAB; i++) {
    used[i] = tab[i].size;
    sum += tab[i].type * tab[i].size;
  }
  printf("%d %s %s\n", sum, tab[0].name, tab[N_TAB - 1].name);

  for (const FieldDef *p = fields; p->name; p++) printf("%s@%d ", p->name, (int)p->off);
  printf("\n");

  printf("%d %d %d\n", (int)sizeof(nvalue), (int)sizeof ((Rec *)0)->d,
    (int)sizeof(Rec));

  /* 转换的常量折叠：这几个数都在编译期出来 */
  printf("%d %u %d %ld\n", (int)(char)300, (unsigned)(int)-1,
    (int)(short)70000, (long)(unsigned char)-1);

  printf("%d %d\n", quad(3), twice(5));
  if (__builtin_expect(sum > 0, 1)) printf("expect ok\n");
  int t = __builtin_expect(twice(6), 0);
  printf("%d\n", t);

  return (int)N_TAB + t + (int)sizeof(nvalue);
}
