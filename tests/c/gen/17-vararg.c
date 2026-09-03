/* 第六刀第十六片：变参函数的**定义**（`va_list` / `va_start` / `va_arg`）。
 *
 * 调用约定：变参函数的 MIR 签名是**定死的** —— 固定形参加一个隐藏的最后一个形参，
 * 指向调用方帧上的一块「变参区」（一格 8 字节，顺序照实参，写的时候只写自己那几个
 * 字节，读的时候按 `va_arg` 要的类型读）。自家的函数与外部的（`printf`）**一个形状**，
 * 所以调用点不必知道这个名字最后有没有定义，照旧发 CALL；宿主那边的 `printf`
 * 也从那块变参区里读实参，与它在真的 ABI 上做的事一模一样。
 *
 * 写法用 `__builtin_va_*` 而**不**用 `<stdarg.h>`：这一份验的正是那几个内建本身。
 * tcc 在 arm64 上 `va_start`/`va_arg` 就是内建，`va_list` 是 tccdefs.h 里的 typedef，
 * `va_end`/`va_copy` 是那儿的两个宏 —— 标准的那层名字在
 * `src/include/stdarg.h`（第八刀第二片），gen/28 那一份验它。
 *
 * printf 一定要有声明：arm64 的变参走栈，没声明时 **tcc 自己**会编错。 */

#include <stdio.h>
#include <string.h>

/* 一、最基本的一格：数个整数加起来 */
static int total(int n, ...) {
  __builtin_va_list ap;
  int s = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, int);
  __builtin_va_end(ap);
  return s;
}

/* 二、浮点：变参里的 `float` 已经被默认实参提升成 double */
static double dsum(int n, ...) {
  __builtin_va_list ap;
  double s = 0.0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) s += __builtin_va_arg(ap, double);
  __builtin_va_end(ap);
  return s;
}

/* 三、指针：字符串一路串起来 */
static void show(const char *tag, int n, ...) {
  __builtin_va_list ap;
  int i;
  __builtin_va_start(ap, n);
  printf("%s:", tag);
  for (i = 0; i < n; i++) printf(" %s", __builtin_va_arg(ap, const char *));
  printf("\n");
  __builtin_va_end(ap);
}

/* 四、混着来 + `va_copy`（拷一份游标，再走一遍） */
static int mixed(int n, ...) {
  __builtin_va_list ap;
  __builtin_va_list cp;
  int a, b;
  long long c;
  double d;
  unsigned int u;
  __builtin_va_start(ap, n);
  a = __builtin_va_arg(ap, int);
  __builtin_va_copy(cp, ap);
  b = __builtin_va_arg(ap, int);
  c = __builtin_va_arg(ap, long long);
  d = __builtin_va_arg(ap, double);
  u = __builtin_va_arg(ap, unsigned int);
  __builtin_va_end(ap);
  printf("%d %d %lld %.1f %u | again %d\n", a, b, c, d, u,
    __builtin_va_arg(cp, int));
  __builtin_va_end(cp);
  return a + b + (int)c + (int)d;
}

/* 五、变参里再调变参：里层那块变参区在**这个**帧上，与外层那块互不相干 */
static int nested(int n, ...) {
  __builtin_va_list ap;
  int s = 0;
  int i;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) {
    int v = __builtin_va_arg(ap, int);
    s += total(2, v, v);          // 里层的变参调用
    printf("[%d]", v);            // 外部的变参调用
  }
  __builtin_va_end(ap);
  printf("\n");
  return s;
}

/* 六、递归的变参函数：每一层自己的变参区 */
static int down(int n, ...) {
  __builtin_va_list ap;
  int first;
  if (n == 0) return 0;
  __builtin_va_start(ap, n);
  first = __builtin_va_arg(ap, int);
  __builtin_va_end(ap);
  return first + down(n - 1, first * 2, 0, 0);
}

/* 七、`va_arg` 取回来的东西当左值用不了，但拿来算随便：这里顺手转发给 sprintf */
static int tagged(char *buf, int n, ...) {
  __builtin_va_list ap;
  int i;
  int at = 0;
  __builtin_va_start(ap, n);
  for (i = 0; i < n; i++) {
    at += sprintf(buf + at, "<%d>", __builtin_va_arg(ap, int));
  }
  __builtin_va_end(ap);
  return at;
}

int main(void) {
  printf("%d %d %d\n", total(0), total(3, 1, 2, 3), total(5, 1, 1, 1, 1, 1));
  printf("%d %d\n", total(2, -5, 5), total(1, 255));
  printf("%.2f %.2f\n", dsum(3, 0.5, 1.25, 2.0), dsum(1, -0.5));
  show("words", 3, "a", "bb", "ccc");
  show("none", 0);
  int r = mixed(5, 10, 20, 30LL, 1.5, 4000000000u);
  printf("%d\n", r);
  printf("%d\n", nested(3, 1, 2, 3));
  printf("%d\n", down(3, 7, 8, 9));

  char buf[64];
  int len = tagged(buf, 3, 1, 22, 333);
  printf("%s %d %d\n", buf, len, (int)strlen(buf));

  return (r + total(2, 3, 4)) & 255;
}
