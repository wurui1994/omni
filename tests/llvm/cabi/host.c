/*
 * `probe.sx` 那几个 `(cabi …)` 的**另一端**（ADR-0022 的 J4b）。
 *
 * 刻意写成一份独立的 `.c`：这一条要证的正是「这个模块自己声明的外部符号，体在别人那儿」——
 * AOT 那一路把它链进去，JIT 那一路把它编成 dylib 再 `--lib` 装进来，两路走的是同一份体。
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

int64_t omni_probe_add(int64_t a, int64_t b) { return a + b; }

double omni_probe_scale(double x, int64_t n) { return x * (double)n; }

/* ptr 那一格：这个方言里地址就是一个整数，所以空指针进来是 0 —— 回 -1，
   好让「它真的按指针收了」这件事在输出上看得见。 */
int64_t omni_probe_len(const char *s) { return s == NULL ? -1 : (int64_t)strlen(s); }

void omni_probe_hi(void) { printf("hi from host\n"); }
