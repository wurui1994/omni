/*
 * `probe.sx` 那几个 `(cabi …)` 的**另一端**（ADR-0022 的 J4b）。
 *
 * 刻意写成一份独立的 `.c`：这一条要证的正是「这个模块自己声明的外部符号，体在别人那儿」——
 * AOT 那一路把它链进去，JIT 那一路把它编成 dylib 再 `--lib` 装进来，两路走的是同一份体。
 */

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int64_t omni_probe_add(int64_t a, int64_t b) { return a + b; }

double omni_probe_scale(double x, int64_t n) { return x * (double)n; }

/* ptr 那一格：这个方言里地址就是一个整数，所以空指针进来是 0 —— 回 -1，
   好让「它真的按指针收了」这件事在输出上看得见。 */
int64_t omni_probe_len(const char *s) { return s == NULL ? -1 : (int64_t)strlen(s); }

void omni_probe_hi(void) { printf("hi from host\n"); }

/* 变参那一格（`(cabi f R (T ...))`，ADR-0022 的 J4d）。为什么值得有一份判据：苹果 arm64 上
   变参一律走**栈**而定参走寄存器，分界差一格就是读错地方（量出来过一次：
   `printf("hi %d\n", 7)` 把 7 当成了定参，印出 1860954544）。第一格是定参 —— 后面有几个 ——
   拿 va_arg 逐个取出来加起来，错了在输出上当场看得见。 */
int64_t omni_probe_sum(int64_t n, ...) {
  va_list ap;
  int64_t acc = 0;
  va_start(ap, n);
  for (int64_t i = 0; i < n; i++) acc += va_arg(ap, int64_t);
  va_end(ap);
  return acc;
}
